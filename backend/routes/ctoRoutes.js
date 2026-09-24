 
const db      = require('../db');
const express = require('express');
const router  = express.Router();
const { authenticateToken, requireAdmin, requireSelfOrAdmin, logAudit } = require('../middleware/auth');
const { getCtoCreditRunningTotals, getCtoEmployeeDisplayRemainingAsync } = require('../services/ctoCreditRunningTotals');
const {
  recomputeCtoLedgerFields,
  recomputeCtoLedgerFieldsAsync,
  findLatestCtoPeriodRow,
  syncCtoEmployeeCarriesAsync,
  repairCtoSnapshotAfterUndo,
  stampCtoEntryDeltaRemarks,
  isCtoOtUndoableSnapshot,
  queryAsync,
  loadCtoPeriodHistoryAsync,
  countCtoUndoClicksUsedAsync,
  CTO_UNDO_MAX_PER_PERIOD,
  isCtoCommutedLocked,
  assertCtoPeriodIsCurrentDisplay,
  assertCtoPeriodAssignableForCredits,
  isCtoPeriodKeyClosed,
} = require('../utils/ctoBalanceUtils');
const { getPromiseConnection } = require('../services/leaveCreditUsageService');
const { commuteCtoPeriod } = require('./commutation');
const { notifyEarningsChanged } = require('../socket/socketService');

const emitCtoChanged = (action, payload = {}) => {
  try {
    notifyEarningsChanged(action, { module: 'cto', ...payload });
  } catch (e) {
    console.warn('[cto_credit] socket notify (non-fatal):', e?.message || e);
  }
};

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const parseDbHours = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim();
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const normalizeCtoRow = (r) => ({
  ...r,
  ot_hours: parseDbHours(r.ot_hours),
  earned_hours: parseDbHours(r.earned_hours),
  total_hours: parseDbHours(r.total_hours),
  carried_forward_hours: parseDbHours(r.carried_forward_hours),
  remaining_hours: parseDbHours(r.remaining_hours),
  used_hours: parseDbHours(r.used_hours),
  commuted_hours: parseDbHours(r.commuted_hours),
  commuted_days: parseDbHours(r.commuted_days),
});

const insertTransactionLog = (employeeId, message) =>
  new Promise((resolve) => {
    if (!employeeId || !message) return resolve();
    db.query(
      "INSERT INTO transaction_table (employee_id, message) VALUES (?, ?)",
      [String(employeeId), String(message).slice(0, 4000)],
      () => resolve(),
    );
  });

const getActorEmpNum = (req) => (req?.user?.employeeNumber ? String(req.user.employeeNumber) : null);

const getEmployeeFullName = (employeeNumber) =>
  new Promise((resolve) => {
    const emp = String(employeeNumber || "").trim();
    if (!emp) return resolve("");
    db.query(
      `SELECT CONCAT_WS(' ', firstName, middleName, lastName, nameExtension) AS fullName
       FROM person_table
       WHERE TRIM(CAST(agencyEmployeeNum AS CHAR)) = TRIM(?)
       LIMIT 1`,
      [emp],
      (err, rows) => {
        if (err) return resolve("");
        resolve((rows && rows[0] && rows[0].fullName) ? String(rows[0].fullName) : "");
      },
    );
  });

const formatUserDisplayName = (employeeNumber, fullName) => {
  const emp = employeeNumber ? String(employeeNumber) : "unknown";
  const name = (fullName || "").trim();
  return name ? `${name} (${emp})` : emp;
};

const fmtPeriod = (y, m) => {
  const yy = y != null && String(y).trim() !== "" ? String(y).trim() : "—";
  const mmRaw = m != null && String(m).trim() !== "" ? String(m).trim() : "00";
  const mm = String(parseInt(mmRaw, 10) || 0).padStart(2, "0");
  return `${yy}-${mm}`;
};

const auditCto = async ({ req, action, recordId, targetEmployeeNumber, details }) => {
  try {
    logAudit(
      { employeeNumber: getActorEmpNum(req) },
      action,
      "cto_credit",
      recordId,
      targetEmployeeNumber != null ? String(targetEmployeeNumber) : null,
      details,
    );
  } catch {}
};

/** Always mirror balance changes to transaction_table + audit_log (same pattern as leave_assignment). */
const logCtoBalanceChange = async ({
  req,
  targetEmp,
  recordId,
  action,
  period_year,
  period_month,
  balBeforeRem,
  balAfterRem,
  details = {},
}) => {
  const actorEmp = getActorEmpNum(req);
  const emp = String(targetEmp || "").trim();
  if (!emp) return;
  const [actorName, targetName] = await Promise.all([
    getEmployeeFullName(actorEmp),
    getEmployeeFullName(emp),
  ]);
  const actorDisplay = formatUserDisplayName(actorEmp, actorName);
  const targetDisplay = formatUserDisplayName(emp, targetName);
  const hasBal =
    balBeforeRem != null &&
    balAfterRem != null &&
    Number.isFinite(Number(balBeforeRem)) &&
    Number.isFinite(Number(balAfterRem));
  const b0 = hasBal ? toNum(balBeforeRem) : null;
  const b1 = hasBal ? toNum(balAfterRem) : null;
  const delta = hasBal ? b1 - b0 : null;
  const balPart = hasBal
    ? ` Balance updated: ${b0.toFixed(3)} hrs → ${b1.toFixed(3)} hrs (${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(3)} hrs).`
    : "";
  const msg = `${actorDisplay} ${action} Compensatory Time Off for ${targetDisplay} (record #${recordId}) for period ${fmtPeriod(period_year, period_month)}.${balPart}`;
  await insertTransactionLog(emp, msg);
  await auditCto({
    req,
    action,
    recordId,
    targetEmployeeNumber: emp,
    details: {
      ...details,
      transaction_message: msg,
      ...(hasBal
        ? {
            balance_before_remaining: b0,
            balance_after_remaining: b1,
            balance_delta_remaining: delta,
          }
        : {}),
    },
  });
};

// ─── GET /cto ─────────────────────────────────────────────────────────────────
router.get('/cto', authenticateToken, requireAdmin, (req, res) => {
  const empFilter = String(req.query.employeeNumber || '').trim();
  const params = [];
  let q = `
    SELECT c.*,
           lc.commutation_id,
           lc.commuted_hours,
           lc.commuted_days,
           CONCAT(p.firstName, ' ', p.lastName) AS fullName,
           p.firstName, p.lastName
    FROM cto_credit c
    LEFT JOIN (
      SELECT cto_credit_id,
             MAX(id) AS commutation_id,
             MAX(commuted_hours) AS commuted_hours,
             MAX(commuted_days) AS commuted_days
      FROM leave_commutation
      WHERE status != 3 AND cto_credit_id IS NOT NULL
      GROUP BY cto_credit_id
    ) lc ON lc.cto_credit_id = c.id
    LEFT JOIN users u         ON u.employeeNumber        = c.employeeNumber
    LEFT JOIN person_table p  ON p.agencyEmployeeNum     = c.employeeNumber
  `;
  if (empFilter) {
    q += ' WHERE c.employeeNumber = ?';
    params.push(empFilter);
  }
  q += ' ORDER BY c.period_year DESC, c.period_month DESC, c.id DESC';

  db.query(q, params, (err, rows) => {
    if (err) {
      console.error('cto GET error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(Array.isArray(rows) ? rows.map(normalizeCtoRow) : rows);
  });
});

// ─── POST /cto/sync-carries/:employeeNumber ───────────────────────────────────
router.post('/cto/sync-carries/:employeeNumber', authenticateToken, requireAdmin, async (req, res) => {
  const emp = String(req.params.employeeNumber || '').trim();
  if (!emp) return res.status(400).json({ error: 'employeeNumber required' });
  try {
    const synced = await syncCtoEmployeeCarriesAsync(db, emp);
    res.json({ synced, employeeNumber: emp });
  } catch (e) {
    console.error('[cto] sync-carries:', e.message);
    res.status(500).json({ error: e.message || 'Failed to sync carry-forward' });
  }
});

// ─── GET /cto/period-history ──────────────────────────────────────────────────
router.get('/cto/period-history', authenticateToken, requireAdmin, async (req, res) => {
  const emp = String(req.query.employeeNumber || '').trim();
  const py = req.query.period_year;
  const pmRaw = req.query.period_month;

  if (!emp || py == null || String(py).trim() === '') {
    return res.status(400).json({ error: 'employeeNumber and period_year are required' });
  }

  const pm =
    pmRaw != null && String(pmRaw).trim() !== ''
      ? parseInt(String(pmRaw), 10)
      : null;

  try {
    const history = await loadCtoPeriodHistoryAsync(db, emp, py, pm);
    res.json(history);
  } catch (e) {
    console.error('[cto] period-history:', e.message);
    res.status(500).json({ error: e.message || 'Failed to load period history' });
  }
});

// ─── POST /cto/:id/undo-entry ─────────────────────────────────────────────────
router.post('/cto/:id/undo-entry', authenticateToken, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });

  const conn = await getPromiseConnection();
  try {
    await conn.beginTransaction();

    const [lockRows] = await conn.execute(
      'SELECT * FROM cto_credit WHERE id = ? FOR UPDATE',
      [id],
    );
    const row = lockRows[0];
    if (!row) {
      await conn.rollback();
      return res.status(404).json({ error: 'CTO credit record not found' });
    }
    if (row.voided_at) {
      await conn.rollback();
      return res.status(400).json({ error: 'Record is already voided' });
    }
    if (isCtoCommutedLocked(row)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Cannot undo a commuted period' });
    }

    const emp = String(row.employeeNumber || '').trim();
    const py = row.period_year;
    const pm =
      row.period_month != null && String(row.period_month).trim() !== ''
        ? parseInt(row.period_month, 10)
        : null;

    const latest = await findLatestCtoPeriodRow(conn, emp, py, pm);
    if (!latest || Number(latest.id) !== id) {
      await conn.rollback();
      return res.status(400).json({ error: 'Only the latest active snapshot can be undone' });
    }

    let activeCountSql = `SELECT COUNT(*) AS c FROM cto_credit
                          WHERE employeeNumber = ? AND period_year = ?
                            AND voided_at IS NULL AND (commuted IS NULL OR commuted = 0)`;
    const activeCountParams = [emp, py];
    if (pm != null) {
      activeCountSql += ' AND period_month = ?';
      activeCountParams.push(pm);
    } else {
      activeCountSql += ' AND period_month IS NULL';
    }

    const [undoUsed, activeCountRows, balBefore] = await (async () => {
      const used = await countCtoUndoClicksUsedAsync(conn, emp, py, pm);
      const countRows = await queryAsync(conn, activeCountSql, activeCountParams);
      const bal = await getCtoEmployeeDisplayRemainingAsync(conn, emp);
      return [used, countRows, bal];
    })();

    if (undoUsed >= CTO_UNDO_MAX_PER_PERIOD) {
      await conn.rollback();
      return res.status(400).json({
        error: `Undo limit reached (${CTO_UNDO_MAX_PER_PERIOD} per period)`,
        undo_clicks_used: undoUsed,
        undo_clicks_remaining: 0,
      });
    }

    const activeCount = Number(activeCountRows[0]?.c) || 0;
    if (activeCount <= 1) {
      await conn.rollback();
      return res.status(400).json({ error: 'Cannot undo the first entry for this period' });
    }

    const periodRows = await queryAsync(
      conn,
      `SELECT * FROM cto_credit
       WHERE employeeNumber = ? AND period_year = ?
         AND (period_month = ? OR (? IS NULL AND period_month IS NULL))
       ORDER BY id ASC`,
      [emp, py, pm, pm],
    );
    const rowIdx = periodRows.findIndex((r) => Number(r.id) === id);
    const prevRow = rowIdx > 0 ? periodRows[rowIdx - 1] : null;
    if (!isCtoOtUndoableSnapshot(row, prevRow, periodRows, rowIdx >= 0 ? rowIdx : periodRows.length - 1)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Only OT addition entries can be undone here' });
    }

    await conn.execute(
      'UPDATE cto_credit SET voided_at = NOW() WHERE id = ? AND voided_at IS NULL',
      [id],
    );

    const newLatest = await findLatestCtoPeriodRow(conn, emp, py, pm);
    if (newLatest) {
      await repairCtoSnapshotAfterUndo(conn, newLatest);
    }

    await conn.commit();

    await syncCtoEmployeeCarriesAsync(db, emp);

    const undoClicksUsed = undoUsed + 1;
    const [balAfter, periodHistory, employeeRecords] = await Promise.all([
      getCtoEmployeeDisplayRemainingAsync(db, emp),
      loadCtoPeriodHistoryAsync(db, emp, py, pm, undoClicksUsed),
      queryAsync(
        db,
        `SELECT * FROM cto_credit WHERE employeeNumber = ?
         ORDER BY period_year DESC, period_month DESC, id DESC`,
        [emp],
      ),
    ]);

    const payload = {
      message: 'Last entry undone',
      id,
      employeeNumber: emp,
      new_active_id: newLatest?.id ?? null,
      balance_after: balAfter,
      undo_clicks_used: undoClicksUsed,
      undo_clicks_remaining: Math.max(0, CTO_UNDO_MAX_PER_PERIOD - undoClicksUsed),
      period_history: periodHistory,
      employee_records: employeeRecords,
    };

    res.json(payload);

    emitCtoChanged('updated', {
      employeeNumber: emp,
      period_year: py,
      period_month: pm,
      cto_credit_id: id,
      undo: true,
    });

    logCtoBalanceChange({
      req,
      targetEmp: emp,
      recordId: id,
      action: 'undo entry',
      period_year: py,
      period_month: pm,
      balBeforeRem: balBefore,
      balAfterRem: balAfter,
      details: {
        voided_cto_credit_id: id,
        period_year: py,
        period_month: pm,
        new_active_id: newLatest?.id ?? null,
        undo_clicks_used: undoClicksUsed,
      },
    }).catch((e) => {
      console.error('[cto] undo-entry audit (background):', e.message);
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error('[cto] undo-entry:', e.message);
    res.status(500).json({ error: e.message || 'Failed to undo entry' });
  } finally {
    try {
      if (conn) conn.release();
    } catch {}
  }
});

// ─── GET /cto/:id/audit ───────────────────────────────────────────────────────
router.get('/cto/:id/audit', authenticateToken, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  db.query(
    `SELECT *
     FROM audit_log
     WHERE table_name = 'cto_credit' AND record_id = ?
     ORDER BY timestamp DESC
     LIMIT 200`,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Failed to fetch audit logs" });
      res.json(Array.isArray(rows) ? rows : []);
    },
  );
});

// ─── POST /cto ────────────────────────────────────────────────────────────────
router.post('/cto', authenticateToken, requireAdmin, async (req, res) => {
  const {
    employeeNumber,
    ot_hours,
    earned_hours,
    remaining_hours,
    used_hours,
    period_year,
    period_month,
    expiry_date,
    remarks,
    emp_category_snapshot,
  } = req.body;

  const emp = String(employeeNumber || '').trim();
  if (!emp) return res.status(400).json({ error: 'employeeNumber is required' });

  const py = parseInt(period_year, 10) || null;
  const pm =
    period_month != null && String(period_month).trim() !== ''
      ? parseInt(period_month, 10)
      : null;

  try {
    const allRows = await queryAsync(
      db,
      'SELECT * FROM cto_credit WHERE employeeNumber = ?',
      [emp],
    );
    const assignCheck = assertCtoPeriodAssignableForCredits(allRows, py, pm);
    if (!assignCheck.ok) {
      return res.status(400).json({ error: assignCheck.error });
    }
  } catch (e) {
    console.error('[cto] POST assign guard:', e.message);
    return res.status(500).json({ error: e.message });
  }

  const otVal = toNum(ot_hours);
  const otEarned = toNum(earned_hours) || otVal;
  const usedVal = toNum(used_hours);
  const carryVal = toNum(req.body.carried_forward_hours);
  const working = {
    employeeNumber,
    ot_hours: otVal,
    earned_hours: otEarned,
    used_hours: usedVal,
    carried_forward_hours: carryVal,
    period_year,
    period_month,
  };
  const ledger = recomputeCtoLedgerFields(working);
  const entryDelta = Math.max(0, toNum(ledger.earned_hours) - carryVal);
  const stampedRemarks = stampCtoEntryDeltaRemarks(remarks, entryDelta);

  const q = `
    INSERT INTO cto_credit
    (
      employeeNumber,
      ot_hours,
      earned_hours,
      total_hours,
      carried_forward_hours,
      remaining_hours,
      used_hours,
      earning_status,
      period_year,
      period_month,
      expiry_date,
      remarks,
      emp_category_snapshot
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `;

  const values = [
    employeeNumber,
    otVal,
    ledger.earned_hours,
    ledger.total_hours,
    ledger.carried_forward_hours,
    ledger.remaining_hours,
    ledger.used_hours,
    ledger.earning_status,
    parseInt(period_year, 10) || null,
    period_month || null,
    expiry_date || null,
    stampedRemarks,
    emp_category_snapshot || null,
  ];

  db.query(q, values, async (err, result) => {
    if (err) {
      console.error('cto POST error:', err);
      return res.status(500).json({ error: err.message });
    }

    const newId = result.insertId;
    const emp = String(employeeNumber || "").trim();
    const rem = ledger.remaining_hours;

    try {
      getCtoCreditRunningTotals(emp, async (errBefore, curBefore) => {
        const balBefore = errBefore ? 0 : Math.max(0, toNum(curBefore?.remaining) - rem);
        try {
          await logCtoBalanceChange({
            req,
            targetEmp: emp,
            recordId: newId,
            action: "assigned",
            period_year,
            period_month,
            balBeforeRem: balBefore,
            balAfterRem: rem,
            details: {
              employeeNumber: emp,
              ot_hours: otVal,
              earned_hours: ledger.earned_hours,
              period_year,
              period_month,
              expiry_date,
              remarks,
              source: "cto_credit_create",
            },
          });
          emitCtoChanged('updated', {
            employeeNumber: emp,
            period_year,
            period_month,
            cto_credit_id: newId,
          });
          res.json({ id: newId, ...req.body, ...ledger });
        } catch (e) {
          console.error("[cto] POST audit:", e.message);
          res.status(500).json({ error: "CTO saved but failed to write audit log" });
        }
      });
    } catch (e) {
      console.error("[cto] POST error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// ─── PUT /cto/:id ─────────────────────────────────────────────────────────────
// Append-only ledger snapshot (do not UPDATE in place — running balance reads latest id).
router.put('/cto/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { ot_hours, earned_hours, used_hours, expiry_date, remarks } = req.body;

  db.query('SELECT * FROM cto_credit WHERE id = ?', [id], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const rec = rows[0];
    const emp = rec.employeeNumber;

    if (rec.voided_at || isCtoCommutedLocked(rec)) {
      return res.status(400).json({
        error: 'This period is voided or commuted and cannot receive new credits.',
      });
    }

    try {
      const allRows = await queryAsync(
        db,
        'SELECT * FROM cto_credit WHERE employeeNumber = ?',
        [String(emp || '').trim()],
      );
      if (isCtoPeriodKeyClosed(allRows, rec.period_year, rec.period_month)) {
        return res.status(400).json({
          error: 'This period is voided or commuted and cannot receive new credits.',
        });
      }
      const currentCheck = assertCtoPeriodIsCurrentDisplay(rec, allRows);
      if (!currentCheck.ok) {
        return res.status(400).json({ error: currentCheck.error });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    const snapEarned = toNum(earned_hours);
    const snapUsed = toNum(used_hours);
    const snapOt = toNum(ot_hours ?? rec.ot_hours);
    const working = {
      ...rec,
      ot_hours: snapOt,
      earned_hours: snapEarned,
      used_hours: snapUsed,
    };

    getCtoCreditRunningTotals(emp, (errSum, cur) => {
      if (errSum) return res.status(500).json({ error: errSum.message });
      const balBefore = cur.remaining;

      recomputeCtoLedgerFieldsAsync(db, working).then((ledger) => {
        const entryDelta = Math.max(0, toNum(ledger.earned_hours) - toNum(rec.earned_hours));
        const baseRemark = [`cto_manual_adjust:source_row_${id}`, remarks]
          .filter(Boolean)
          .join(' · ');
        const ledgerRemark = stampCtoEntryDeltaRemarks(baseRemark, entryDelta);
        const expiryEff = expiry_date != null ? expiry_date : rec.expiry_date;

        db.query(
          `INSERT INTO cto_credit
            (employeeNumber, ot_hours, earned_hours, total_hours, carried_forward_hours, remaining_hours, used_hours, earning_status,
             period_year, period_month, expiry_date, remarks, emp_category_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            emp,
            snapOt,
            ledger.earned_hours,
            ledger.total_hours,
            ledger.carried_forward_hours,
            ledger.remaining_hours,
            ledger.used_hours,
            ledger.earning_status,
            rec.period_year,
            rec.period_month,
            expiryEff,
            ledgerRemark,
            rec.emp_category_snapshot || null,
          ],
          async (errIns, insRes) => {
            if (errIns) return res.status(500).json({ error: errIns.message });
            const newId = insRes.insertId;
            try {
              await logCtoBalanceChange({
                req,
                targetEmp: emp,
                recordId: newId,
                action: "updated",
                period_year: rec.period_year,
                period_month: rec.period_month,
                balBeforeRem: balBefore,
                balAfterRem: ledger.remaining_hours,
                details: {
                  source_cto_credit_id: id,
                  cto_credit_id: newId,
                  ...ledger,
                  ot_hours: snapOt,
                  expiry_date: expiryEff,
                  remarks,
                },
              });
              emitCtoChanged('updated', {
                employeeNumber: emp,
                period_year: rec.period_year,
                period_month: rec.period_month,
                cto_credit_id: newId,
              });
              res.json({
                id: newId,
                ...req.body,
                employeeNumber: emp,
                expiry_date: expiryEff,
                ...ledger,
              });
            } catch (e) {
              console.error("[cto] PUT audit:", e.message);
              res.status(500).json({ error: "Ledger updated but failed to write audit log" });
            }
          },
        );
      }).catch((e) => res.status(500).json({ error: e.message }));
    });
  });
});

// ─── DELETE /cto/:id/void-period ──────────────────────────────────────────────
// Soft-void current period ledger + all cto_earnings for that period.
router.delete('/cto/:id/void-period', authenticateToken, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });

  try {
    const seedRows = await queryAsync(db, 'SELECT * FROM cto_credit WHERE id = ? LIMIT 1', [id]);
    const seed = seedRows[0];
    if (!seed) {
      return res.status(404).json({ error: 'CTO credit period not found' });
    }

    let rec = seed.voided_at ? null : seed;
    if (!rec) {
      const latest = await findLatestCtoPeriodRow(
        db,
        seed.employeeNumber,
        seed.period_year,
        seed.period_month,
      );
      if (latest && !latest.voided_at) rec = latest;
    }
    if (!rec) {
      return res.status(404).json({ error: 'Period not found or already voided' });
    }

    const allRows = await queryAsync(
      db,
      `SELECT * FROM cto_credit WHERE employeeNumber = ?`,
      [String(rec.employeeNumber || '').trim()],
    );
    const currentCheck = assertCtoPeriodIsCurrentDisplay(rec, allRows);
    if (!currentCheck.ok) {
      return res.status(400).json({ error: currentCheck.error });
    }

    const voidId = rec.id;
    const emp = String(rec.employeeNumber || '').trim();
    const py = rec.period_year;
    const pm = rec.period_month != null && String(rec.period_month).trim() !== ''
      ? parseInt(rec.period_month, 10)
      : null;

    getCtoCreditRunningTotals(emp, async (errBefore, curBefore) => {
      const balBefore = errBefore ? 0 : toNum(curBefore?.remaining);

      const voidCto = () =>
        new Promise((resolve, reject) => {
          let sql = `UPDATE cto_credit SET voided_at = NOW()
                     WHERE employeeNumber = ? AND voided_at IS NULL
                       AND period_year = ?`;
          const params = [emp, py];
          if (pm != null) {
            sql += ' AND period_month = ?';
            params.push(pm);
          } else {
            sql += ' AND period_month IS NULL';
          }
          db.query(sql, params, (err, r) => (err ? reject(err) : resolve(r)));
        });

      const voidEarnings = () =>
        new Promise((resolve, reject) => {
          let sql = `UPDATE cto_earnings SET voided_at = NOW(), voided = 1, is_applied = 0
                     WHERE employee_number = ? AND voided_at IS NULL
                       AND period_year = ?`;
          const params = [emp, py];
          if (pm != null) {
            sql += ' AND period_month = ?';
            params.push(pm);
          } else {
            sql += ' AND period_month IS NULL';
          }
          db.query(sql, params, (err, r) => (err ? reject(err) : resolve(r)));
        });

      try {
        await voidCto();
        await voidEarnings();

        getCtoCreditRunningTotals(emp, async (errAfter, curAfter) => {
          const balAfter = errAfter ? 0 : toNum(curAfter?.remaining);
          try {
            await logCtoBalanceChange({
              req,
              targetEmp: emp,
              recordId: voidId,
              action: 'voided current period',
              period_year: py,
              period_month: pm,
              balBeforeRem: balBefore,
              balAfterRem: balAfter,
              details: { voided_cto_credit_id: voidId },
            });
            emitCtoChanged('deleted', {
              employeeNumber: emp,
              period_year: py,
              period_month: pm,
              cto_credit_id: voidId,
            });
            res.json({ message: 'Period voided', id: voidId, employeeNumber: emp, balance_after: balAfter });
          } catch (e) {
            console.error('[cto] void-period audit:', e.message);
            res.status(500).json({ error: 'Voided but failed to write audit log' });
          }
        });
      } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to void period' });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to void period' });
  }
});

// ─── DELETE /cto/:id ──────────────────────────────────────────────────────────
router.delete('/cto/:id', authenticateToken, requireAdmin, (req, res) => {
  res.status(410).json({
    error: 'Single-row delete is no longer supported',
    message: 'Use DELETE /cto/:id/void-period to soft-void the current CTO period and its earnings.',
    void_period_url: `/api/cto/cto/${req.params.id}/void-period`,
  });
});

// ─── POST /cto/:id/action ─────────────────────────────────────────────────────
router.post('/cto/:id/action', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { action, hours, date_used, remarks } = req.body;

  const VALID_ACTIONS = ['offset', 'use_as_leave', 'forfeit'];
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}` });
  }

  db.query('SELECT * FROM cto_credit WHERE id = ?', [id], (err, rows) => {
    if (err)          return res.status(500).json({ error: err.message });
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const rec = rows[0];
    const emp = rec.employeeNumber;

    getCtoCreditRunningTotals(emp, (errSum, cur) => {
      if (errSum) return res.status(500).json({ error: errSum.message });
      const totalRem = cur.remaining;
      const apply = Math.min(parseFloat(hours) || totalRem, Math.max(0, totalRem));
      if (apply <= 0) return res.status(400).json({ error: 'No hours to apply' });

      const baseRow = cur.periodRow || rec;
      const snapUsed = toNum(baseRow.used_hours) + apply;
      const working = { ...baseRow, used_hours: snapUsed };
      const ledgerRemark = `cto_credit_action:source_row_${id}:${action || 'offset'}`;

      recomputeCtoLedgerFieldsAsync(db, working).then((ledger) => {
        db.query(
          `INSERT INTO cto_credit
            (employeeNumber, ot_hours, earned_hours, total_hours, carried_forward_hours, remaining_hours, used_hours, earning_status,
             period_year, period_month, expiry_date, remarks, emp_category_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            emp,
            toNum(baseRow.ot_hours),
            ledger.earned_hours,
            ledger.total_hours,
            ledger.carried_forward_hours,
            ledger.remaining_hours,
            ledger.used_hours,
            ledger.earning_status,
            rec.period_year,
            rec.period_month,
            baseRow.expiry_date || rec.expiry_date || null,
            ledgerRemark,
            baseRow.emp_category_snapshot || rec.emp_category_snapshot || null,
          ],
          (errIns, insRes) => {
            if (errIns) return res.status(500).json({ error: errIns.message });
            const newCtoId = insRes.insertId;
            const snapRem = ledger.remaining_hours;

            db.query(
              `INSERT INTO cto_usage
               (cto_credit_id, employeeNumber, action, hours_applied, date_used, remarks)
               VALUES (?,?,?,?,?,?)`,
              [newCtoId, emp, action, apply, date_used || null, remarks || null],
              (err3) => { if (err3) console.error('CTO usage insert:', err3); },
            );

            (async () => {
              try {
                await logCtoBalanceChange({
                  req,
                  targetEmp: emp,
                  recordId: newCtoId,
                  action: `applied action "${action}" (${toNum(apply).toFixed(3)} hrs deducted)`,
                  period_year: rec.period_year,
                  period_month: rec.period_month,
                  balBeforeRem: totalRem,
                  balAfterRem: snapRem,
                  details: {
                    source_cto_credit_id: id,
                    cto_credit_id: newCtoId,
                    action,
                    hours_applied: apply,
                    date_used: date_used || null,
                    remarks: remarks || null,
                  },
                });
              } catch (e) {
                console.error("[cto] action audit:", e.message);
              }
            })();

            emitCtoChanged('updated', {
              employeeNumber: emp,
              period_year: rec.period_year,
              period_month: rec.period_month,
              action,
              hours_applied: apply,
            });
            res.json({ message: 'Action applied', hours_applied: apply, remaining_hours: snapRem });
          },
        );
      }).catch((e) => res.status(500).json({ error: e.message }));
    });
  });
});

// ─── POST /cto/:id/commute ───────────────────────────────────────────────────
router.post('/cto/:id/commute', authenticateToken, requireAdmin, (req, res) => {
  req.params.ctoCreditId = req.params.id;
  return commuteCtoPeriod(req, res);
});

// ─── GET /cto/:id/usage ───────────────────────────────────────────────────────
router.get('/cto/:id/usage', authenticateToken, requireAdmin, (req, res) => {
  db.query(
    `SELECT * FROM cto_usage WHERE cto_credit_id = ? ORDER BY processed_at DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

// ─── GET /cto/:employeeNumber ─────────────────────────────────────────────────
router.get('/cto/:employeeNumber', authenticateToken, requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const includeVoided =
    req.query.includeVoided === '1' ||
    req.query.include_voided === '1' ||
    req.query.includeVoided === 'true' ||
    req.query.include_voided === 'true';

  let sql = `SELECT * FROM cto_credit WHERE employeeNumber = ?`;
  const params = [req.params.employeeNumber];
  if (!includeVoided) {
    sql += ' AND voided_at IS NULL';
  }
  sql += ' ORDER BY period_year DESC, period_month DESC, id DESC';

  db.query(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(Array.isArray(rows) ? rows.map(normalizeCtoRow) : rows);
  });
});

module.exports = router;
