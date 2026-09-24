 
const db      = require('../db');
const express = require('express');
const router  = express.Router();
const { authenticateToken, requireAdmin, requireSelfOrAdmin, logAudit } = require('../middleware/auth');
const { getServiceCreditRunningTotals, getScEmployeeDisplayRemainingAsync } = require('../services/serviceCreditRunningTotals');
const {
  recomputeScLedgerFields,
  recomputeScLedgerFieldsAsync,
  findLatestScPeriodRow,
  getScDisplayRemainingHours,
  latestScPeriodsByKey,
  syncScEmployeeCarriesAsync,
  repairScSnapshotAfterUndo,
  stampScEntryDeltaRemarks,
  isScOtUndoableSnapshot,
  computeScSnapshotDelta,
  queryAsync,
  loadScPeriodHistoryAsync,
  countScUndoClicksUsedAsync,
  SC_UNDO_MAX_PER_PERIOD,
  isScCommutedLocked,
  assertScPeriodIsCurrentDisplay,
  assertScPeriodAssignableForCredits,
  isScPeriodKeyClosed,
} = require('../utils/serviceCreditBalanceUtils');
const { getPromiseConnection } = require('../services/leaveCreditUsageService');
const { commuteServiceCreditPeriod } = require('./commutation');
const { notifyEarningsChanged } = require('../socket/socketService');

const emitScChanged = (action, payload = {}) => {
  try {
    notifyEarningsChanged(action, { module: 'sc', ...payload });
  } catch (e) {
    console.warn('[service_credit] socket notify (non-fatal):', e?.message || e);
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

const normalizeScRow = (r) => ({
  ...r,
  ot_hours_regular: parseDbHours(r.ot_hours_regular),
  ot_hours_holiday: parseDbHours(r.ot_hours_holiday),
  ot_hours_night_diff: parseDbHours(r.ot_hours_night_diff),
  total_ot_hours: parseDbHours(r.total_ot_hours),
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

const auditSc = async ({ req, action, recordId, targetEmployeeNumber, details }) => {
  try {
    logAudit(
      { employeeNumber: getActorEmpNum(req) },
      action,
      "service_credit",
      recordId,
      targetEmployeeNumber != null ? String(targetEmployeeNumber) : null,
      details,
    );
  } catch {}
};

/** Always mirror balance changes to transaction_table + audit_log (same pattern as leave_assignment). */
const logScBalanceChange = async ({
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
  const msg = `${actorDisplay} ${action} Service Credit for ${targetDisplay} (record #${recordId}) for period ${fmtPeriod(period_year, period_month)}.${balPart}`;
  await insertTransactionLog(emp, msg);
  await auditSc({
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
 
// ─── GET /ot-types ────────────────────────────────────────────────────────────
router.get('/ot-types', (req, res) => {
  db.query(
    `SELECT id, name, description, multiplier, sort_order
     FROM ot_type
     WHERE is_active = 1
     ORDER BY sort_order ASC, name ASC`,
    (err, rows) => {
      if (err) {
        // Table might not exist yet — return empty so frontend uses defaults
        console.warn('ot_type table not ready, returning empty:', err.message);
        return res.json([]);
      }
      res.json(rows);
    }
  );
});
 
// ─── GET /service_credit ─────────────────────────────────────────────────────
router.get('/service_credit', authenticateToken, requireAdmin, (req, res) => {
  const empFilter = String(req.query.employeeNumber || '').trim();
  const params = [];
  let q = `
    SELECT sc.*,
           lc.commutation_id,
           lc.commuted_hours,
           lc.commuted_days,
           CONCAT(p.firstName, ' ', p.lastName) AS fullName,
           p.firstName, p.lastName
    FROM service_credit sc
    LEFT JOIN (
      SELECT service_credit_id,
             MAX(id) AS commutation_id,
             MAX(commuted_hours) AS commuted_hours,
             MAX(commuted_days) AS commuted_days
      FROM leave_commutation
      WHERE status != 3 AND service_credit_id IS NOT NULL
      GROUP BY service_credit_id
    ) lc ON lc.service_credit_id = sc.id
    LEFT JOIN users u         ON u.employeeNumber        = sc.employeeNumber
    LEFT JOIN person_table p  ON p.agencyEmployeeNum     = sc.employeeNumber
  `;
  if (empFilter) {
    q += ' WHERE sc.employeeNumber = ?';
    params.push(empFilter);
  }
  q += ' ORDER BY sc.period_year DESC, sc.period_month DESC, sc.id DESC';

  db.query(q, params, (err, rows) => {
    if (err) {
      console.error('service_credit GET error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(Array.isArray(rows) ? rows.map(normalizeScRow) : rows);
  });
});

// ─── POST /service_credit/sync-carries/:employeeNumber ───────────────────────
// Repair carried_forward_hours on period rows (e.g. after attendance-only deductions).
router.post('/service_credit/sync-carries/:employeeNumber', authenticateToken, requireAdmin, async (req, res) => {
  const emp = String(req.params.employeeNumber || '').trim();
  if (!emp) return res.status(400).json({ error: 'employeeNumber required' });
  const scType = req.body?.sc_type || req.query?.sc_type || 'non_commutative';
  try {
    const synced = await syncScEmployeeCarriesAsync(db, emp, scType);
    res.json({ synced, employeeNumber: emp });
  } catch (e) {
    console.error('[service_credit] sync-carries:', e.message);
    res.status(500).json({ error: e.message || 'Failed to sync carry-forward' });
  }
});

// ─── GET /service_credit/period-history ───────────────────────────────────────
router.get('/service_credit/period-history', authenticateToken, requireAdmin, async (req, res) => {
  const emp = String(req.query.employeeNumber || '').trim();
  const py = req.query.period_year;
  const pmRaw = req.query.period_month;
  const scType = req.query.sc_type || 'non_commutative';

  if (!emp || py == null || String(py).trim() === '') {
    return res.status(400).json({ error: 'employeeNumber and period_year are required' });
  }

  const pm =
    pmRaw != null && String(pmRaw).trim() !== ''
      ? parseInt(String(pmRaw), 10)
      : null;

  try {
    const history = await loadScPeriodHistoryAsync(db, emp, py, pm, scType);
    res.json(history);
  } catch (e) {
    console.error('[service_credit] period-history:', e.message);
    res.status(500).json({ error: e.message || 'Failed to load period history' });
  }
});

// ─── POST /service_credit/:id/undo-entry ──────────────────────────────────────
router.post('/service_credit/:id/undo-entry', authenticateToken, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });

  const conn = await getPromiseConnection();
  try {
    await conn.beginTransaction();

    const [lockRows] = await conn.execute(
      'SELECT * FROM service_credit WHERE id = ? FOR UPDATE',
      [id],
    );
    const row = lockRows[0];
    if (!row) {
      await conn.rollback();
      return res.status(404).json({ error: 'Service credit record not found' });
    }
    if (row.voided_at) {
      await conn.rollback();
      return res.status(400).json({ error: 'Record is already voided' });
    }
    if (isScCommutedLocked(row)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Cannot undo a commuted period' });
    }

    const emp = String(row.employeeNumber || '').trim();
    const scType = row.sc_type || 'non_commutative';
    const py = row.period_year;
    const pm =
      row.period_month != null && String(row.period_month).trim() !== ''
        ? parseInt(row.period_month, 10)
        : null;

    const latest = await findLatestScPeriodRow(conn, emp, scType, py, pm);
    if (!latest || Number(latest.id) !== id) {
      await conn.rollback();
      return res.status(400).json({ error: 'Only the latest active snapshot can be undone' });
    }

    let activeCountSql = `SELECT COUNT(*) AS c FROM service_credit
                          WHERE employeeNumber = ? AND sc_type = ? AND period_year = ?
                            AND voided_at IS NULL AND (commuted IS NULL OR commuted = 0)`;
    const activeCountParams = [emp, scType, py];
    if (pm != null) {
      activeCountSql += ' AND period_month = ?';
      activeCountParams.push(pm);
    } else {
      activeCountSql += ' AND period_month IS NULL';
    }

    const [undoUsed, activeCountRows, balBefore] = await (async () => {
      const used = await countScUndoClicksUsedAsync(conn, emp, py, pm, scType);
      const countRows = await queryAsync(conn, activeCountSql, activeCountParams);
      const bal = await getScEmployeeDisplayRemainingAsync(conn, emp, scType);
      return [used, countRows, bal];
    })();

    if (undoUsed >= SC_UNDO_MAX_PER_PERIOD) {
      await conn.rollback();
      return res.status(400).json({
        error: `Undo limit reached (${SC_UNDO_MAX_PER_PERIOD} per period)`,
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
      `SELECT * FROM service_credit
       WHERE employeeNumber = ? AND sc_type = ? AND period_year = ?
         AND (period_month = ? OR (? IS NULL AND period_month IS NULL))
       ORDER BY id ASC`,
      [emp, scType, py, pm, pm],
    );
    const rowIdx = periodRows.findIndex((r) => Number(r.id) === id);
    const prevRow = rowIdx > 0 ? periodRows[rowIdx - 1] : null;
    if (!isScOtUndoableSnapshot(row, prevRow, periodRows, rowIdx >= 0 ? rowIdx : periodRows.length - 1)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Only OT addition entries can be undone here' });
    }

    await conn.execute(
      'UPDATE service_credit SET voided_at = NOW() WHERE id = ? AND voided_at IS NULL',
      [id],
    );

    const newLatest = await findLatestScPeriodRow(conn, emp, scType, py, pm);
    if (newLatest) {
      await repairScSnapshotAfterUndo(conn, newLatest);
    }

    await conn.commit();

    await syncScEmployeeCarriesAsync(db, emp, scType);

    const undoClicksUsed = undoUsed + 1;
    const [balAfter, periodHistory, employeeRecords] = await Promise.all([
      getScEmployeeDisplayRemainingAsync(db, emp, scType),
      loadScPeriodHistoryAsync(db, emp, py, pm, scType, undoClicksUsed),
      queryAsync(
        db,
        `SELECT * FROM service_credit WHERE employeeNumber = ?
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
      undo_clicks_remaining: Math.max(0, SC_UNDO_MAX_PER_PERIOD - undoClicksUsed),
      period_history: periodHistory,
      employee_records: employeeRecords,
    };

    res.json(payload);

    emitScChanged('updated', {
      employeeNumber: emp,
      period_year: py,
      period_month: pm,
      service_credit_id: id,
      undo: true,
    });

    logScBalanceChange({
      req,
      targetEmp: emp,
      recordId: id,
      action: 'undo entry',
      period_year: py,
      period_month: pm,
      balBeforeRem: balBefore,
      balAfterRem: balAfter,
      details: {
        voided_service_credit_id: id,
        sc_type: scType,
        period_year: py,
        period_month: pm,
        new_active_id: newLatest?.id ?? null,
        undo_clicks_used: undoClicksUsed,
      },
    }).catch((e) => {
      console.error('[service_credit] undo-entry audit (background):', e.message);
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error('[service_credit] undo-entry:', e.message);
    res.status(500).json({ error: e.message || 'Failed to undo entry' });
  } finally {
    try {
      if (conn) conn.release();
    } catch {}
  }
});

// ─── GET /service_credit/:id/audit ───────────────────────────────────────────
router.get('/service_credit/:id/audit', authenticateToken, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  db.query(
    `SELECT *
     FROM audit_log
     WHERE table_name = 'service_credit' AND record_id = ?
     ORDER BY timestamp DESC
     LIMIT 200`,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Failed to fetch audit logs" });
      res.json(Array.isArray(rows) ? rows : []);
    },
  );
});

// ─── POST /service_credit ─────────────────────────────────────────────────────
router.post('/service_credit', authenticateToken, requireAdmin, async (req, res) => {
  const {
    employeeNumber,
    sc_type,
    ot_hours_regular,
    ot_hours_holiday,
    ot_hours_night_diff,
    total_ot_hours,
    earned_hours,
    remaining_hours,
    used_hours,
    period_year,
    period_month,
    remarks,
    emp_category_snapshot,
  } = req.body;

  const emp = String(employeeNumber || '').trim();
  if (!emp) return res.status(400).json({ error: 'employeeNumber is required' });

  const scTypeEff = sc_type || 'non_commutative';
  const py = parseInt(period_year, 10) || null;
  const pm =
    period_month != null && String(period_month).trim() !== ''
      ? parseInt(period_month, 10)
      : null;

  try {
    const allRows = await queryAsync(
      db,
      'SELECT * FROM service_credit WHERE employeeNumber = ? AND sc_type = ?',
      [emp, scTypeEff],
    );
    const assignCheck = assertScPeriodAssignableForCredits(allRows, py, pm, scTypeEff);
    if (!assignCheck.ok) {
      return res.status(400).json({ error: assignCheck.error });
    }
  } catch (e) {
    console.error('[service_credit] POST assign guard:', e.message);
    return res.status(500).json({ error: e.message });
  }

  const otEarned = toNum(earned_hours);
  const usedVal = toNum(used_hours);
  const carryVal = toNum(req.body.carried_forward_hours);
  const working = {
    employeeNumber,
    sc_type: sc_type || 'non_commutative',
    earned_hours: otEarned,
    used_hours: usedVal,
    carried_forward_hours: carryVal,
    period_year,
    period_month,
  };
  const ledger = recomputeScLedgerFields(working);
  const entryDelta = Math.max(0, toNum(ledger.earned_hours) - carryVal);
  const stampedRemarks = stampScEntryDeltaRemarks(remarks, entryDelta);

  const q = `
    INSERT INTO service_credit
    (
      employeeNumber,
      sc_type,
      ot_hours_regular,
      ot_hours_holiday,
      ot_hours_night_diff,
      total_ot_hours,
      earned_hours,
      total_hours,
      carried_forward_hours,
      remaining_hours,
      used_hours,
      earning_status,
      period_year,
      period_month,
      remarks,
      emp_category_snapshot
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `;

  const values = [
    employeeNumber,
    sc_type || 'non_commutative',
    parseFloat(ot_hours_regular) || 0,
    parseFloat(ot_hours_holiday) || 0,
    parseFloat(ot_hours_night_diff) || 0,
    parseFloat(total_ot_hours) || 0,
    ledger.earned_hours,
    ledger.total_hours,
    ledger.carried_forward_hours,
    ledger.remaining_hours,
    ledger.used_hours,
    ledger.earning_status,
    parseInt(period_year, 10) || null,
    period_month || null,
    stampedRemarks,
    emp_category_snapshot || null,
  ];

  db.query(q, values, async (err, result) => {
    if (err) {
      console.error('service_credit POST error:', err);
      return res.status(500).json({ error: err.message });
    }

    const newId = result.insertId;
    const emp = String(employeeNumber || "").trim();
    const earned = ledger.earned_hours;
    const rem = ledger.remaining_hours;

    try {
      getServiceCreditRunningTotals(emp, sc_type || 'non_commutative', async (errBefore, curBefore) => {
        const balBefore = errBefore ? 0 : Math.max(0, toNum(curBefore?.remaining) - rem);
        try {
          await logScBalanceChange({
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
              sc_type,
              earned_hours: earned,
              period_year,
              period_month,
              remarks,
              source: "service_credit_create",
            },
          });
          emitScChanged('updated', {
            employeeNumber: emp,
            period_year,
            period_month,
            service_credit_id: newId,
          });
          res.json({ id: newId, ...req.body, ...ledger });
        } catch (e) {
          console.error("[service_credit] POST audit:", e.message);
          res.status(500).json({ error: "Service credit saved but failed to write audit log" });
        }
      });
    } catch (e) {
      console.error("[service_credit] POST error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
});
 
// ─── PUT /service_credit/:id ──────────────────────────────────────────────────
// Append-only ledger snapshot (do not UPDATE in place — running balance reads latest id).
router.put('/service_credit/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { earned_hours, total_ot_hours, used_hours, remarks, sc_type } = req.body;

  db.query('SELECT * FROM service_credit WHERE id = ?', [id], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const rec = rows[0];
    const emp = rec.employeeNumber;
    const scTypeEff = sc_type || rec.sc_type || 'non_commutative';

    if (rec.voided_at || isScCommutedLocked(rec)) {
      return res.status(400).json({
        error: 'This period is voided or commuted and cannot receive new credits.',
      });
    }

    try {
      const allRows = await queryAsync(
        db,
        'SELECT * FROM service_credit WHERE employeeNumber = ? AND sc_type = ?',
        [String(emp || '').trim(), scTypeEff],
      );
      if (isScPeriodKeyClosed(allRows, rec.period_year, rec.period_month, scTypeEff)) {
        return res.status(400).json({
          error: 'This period is voided or commuted and cannot receive new credits.',
        });
      }
      const currentCheck = assertScPeriodIsCurrentDisplay(rec, allRows);
      if (!currentCheck.ok) {
        return res.status(400).json({ error: currentCheck.error });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    const snapEarned = toNum(earned_hours);
    const snapUsed = toNum(used_hours);
    const working = {
      ...rec,
      earned_hours: snapEarned,
      used_hours: snapUsed,
    };

    getServiceCreditRunningTotals(emp, scTypeEff, (errSum, cur) => {
      if (errSum) return res.status(500).json({ error: errSum.message });
      const balBefore = cur.remaining;

      recomputeScLedgerFieldsAsync(db, working).then((ledger) => {
        const entryDelta = Math.max(0, toNum(ledger.earned_hours) - toNum(rec.earned_hours));
        const baseRemark = [`service_credit_manual_adjust:source_row_${id}`, remarks]
          .filter(Boolean)
          .join(' · ');
        const ledgerRemark = stampScEntryDeltaRemarks(baseRemark, entryDelta);

        db.query(
          `INSERT INTO service_credit
            (employeeNumber, sc_type, ot_hours_regular, ot_hours_holiday, ot_hours_night_diff, total_ot_hours,
             earned_hours, total_hours, carried_forward_hours, remaining_hours, used_hours, earning_status,
             period_year, period_month, remarks, emp_category_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            emp,
            scTypeEff,
            toNum(req.body.ot_hours_regular ?? rec.ot_hours_regular),
            toNum(req.body.ot_hours_holiday ?? rec.ot_hours_holiday),
            toNum(req.body.ot_hours_night_diff ?? rec.ot_hours_night_diff),
            toNum(total_ot_hours),
            ledger.earned_hours,
            ledger.total_hours,
            ledger.carried_forward_hours,
            ledger.remaining_hours,
            ledger.used_hours,
            ledger.earning_status,
            rec.period_year,
            rec.period_month,
            ledgerRemark,
            rec.emp_category_snapshot || null,
          ],
          async (errIns, insRes) => {
            if (errIns) return res.status(500).json({ error: errIns.message });
            const newId = insRes.insertId;
            try {
              await logScBalanceChange({
                req,
                targetEmp: emp,
                recordId: newId,
                action: "updated",
                period_year: rec.period_year,
                period_month: rec.period_month,
                balBeforeRem: balBefore,
                balAfterRem: ledger.remaining_hours,
                details: {
                  source_service_credit_id: id,
                  service_credit_id: newId,
                  ...ledger,
                  total_ot_hours: toNum(total_ot_hours),
                  sc_type: scTypeEff,
                  remarks,
                },
              });
              emitScChanged('updated', {
                employeeNumber: emp,
                period_year: rec.period_year,
                period_month: rec.period_month,
                service_credit_id: newId,
              });
              res.json({
                id: newId,
                ...req.body,
                employeeNumber: emp,
                sc_type: scTypeEff,
                ...ledger,
              });
            } catch (e) {
              console.error("[service_credit] PUT audit:", e.message);
              res.status(500).json({ error: "Ledger updated but failed to write audit log" });
            }
          },
        );
      }).catch((e) => res.status(500).json({ error: e.message }));
    });
  });
});
 
// ─── DELETE /service_credit/:id/void-period ───────────────────────────────────
// Soft-void current period ledger + all sc_earnings for that period.
router.delete('/service_credit/:id/void-period', authenticateToken, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });

  try {
    const seedRows = await queryAsync(db, 'SELECT * FROM service_credit WHERE id = ? LIMIT 1', [id]);
    const seed = seedRows[0];
    if (!seed) {
      return res.status(404).json({ error: 'Service credit period not found' });
    }

    let rec = seed.voided_at
      ? null
      : seed;
    if (!rec) {
      const latest = await findLatestScPeriodRow(
        db,
        seed.employeeNumber,
        seed.sc_type || 'non_commutative',
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
      `SELECT * FROM service_credit WHERE employeeNumber = ? AND sc_type = ?`,
      [String(rec.employeeNumber || '').trim(), rec.sc_type || 'non_commutative'],
    );
    const currentCheck = assertScPeriodIsCurrentDisplay(rec, allRows);
    if (!currentCheck.ok) {
      return res.status(400).json({ error: currentCheck.error });
    }

    const voidId = rec.id;
    const emp = String(rec.employeeNumber || '').trim();
    const scType = rec.sc_type || 'non_commutative';
    const py = rec.period_year;
    const pm = rec.period_month != null && String(rec.period_month).trim() !== ''
      ? parseInt(rec.period_month, 10)
      : null;

    getServiceCreditRunningTotals(emp, scType, async (errBefore, curBefore) => {
      const balBefore = errBefore ? 0 : toNum(curBefore?.remaining);

      const voidSc = () =>
        new Promise((resolve, reject) => {
          let sql = `UPDATE service_credit SET voided_at = NOW()
                     WHERE employeeNumber = ? AND sc_type = ? AND voided_at IS NULL
                       AND period_year = ?`;
          const params = [emp, scType, py];
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
          let sql = `UPDATE sc_earnings SET voided_at = NOW(), voided = 1, is_applied = 0
                     WHERE employee_number = ? AND sc_type = ? AND voided_at IS NULL
                       AND period_year = ?`;
          const params = [emp, scType, py];
          if (pm != null) {
            sql += ' AND period_month = ?';
            params.push(pm);
          } else {
            sql += ' AND period_month IS NULL';
          }
          db.query(sql, params, (err, r) => (err ? reject(err) : resolve(r)));
        });

      try {
        await voidSc();
        await voidEarnings();

        getServiceCreditRunningTotals(emp, scType, async (errAfter, curAfter) => {
          const balAfter = errAfter ? 0 : toNum(curAfter?.remaining);
          try {
            await logScBalanceChange({
              req,
              targetEmp: emp,
              recordId: voidId,
              action: 'voided current period',
              period_year: py,
              period_month: pm,
              balBeforeRem: balBefore,
              balAfterRem: balAfter,
              details: { voided_service_credit_id: voidId, sc_type: scType },
            });
            emitScChanged('deleted', {
              employeeNumber: emp,
              period_year: py,
              period_month: pm,
              service_credit_id: voidId,
            });
            res.json({ message: 'Period voided', id: voidId, employeeNumber: emp, balance_after: balAfter });
          } catch (e) {
            console.error('[service_credit] void-period audit:', e.message);
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

// ─── DELETE /service_credit/:id ───────────────────────────────────────────────
router.delete('/service_credit/:id', authenticateToken, requireAdmin, (req, res) => {
  const id = req.params.id;
  db.query('SELECT employeeNumber FROM service_credit WHERE id = ? LIMIT 1', [id], (e0, rows0) => {
    const emp = !e0 && rows0 && rows0[0] ? rows0[0].employeeNumber : null;
    db.query('UPDATE service_credit SET voided_at = NOW() WHERE id = ? AND voided_at IS NULL', [id], async (err, r) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    const targetEmp = String(emp || "").trim();
    try {
      await logScBalanceChange({
        req,
        targetEmp,
        recordId: id,
        action: "deleted",
        period_year: null,
        period_month: null,
        balBeforeRem: null,
        balAfterRem: null,
        details: { id, source: "service_credit_delete" },
      });
      emitScChanged('deleted', {
        employeeNumber: targetEmp,
        service_credit_id: id,
      });
      res.json({ message: 'Deleted' });
    } catch (e) {
      console.error("[service_credit] DELETE audit:", e.message);
      res.status(500).json({ error: "Record deleted but failed to write audit log" });
    }
    });
  });
});
 
// ─── POST /service_credit/:id/action ──────────────────────────────────────────
router.post('/service_credit/:id/action', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { action, hours, targetLeaveCode } = req.body;
 
  db.query('SELECT * FROM service_credit WHERE id = ?', [id], (err, rows) => {
    if (err)          return res.status(500).json({ error: err.message });
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
 
    const rec    = rows[0];
    const scType = rec.sc_type || 'non_commutative';
    const emp    = rec.employeeNumber;

    getServiceCreditRunningTotals(emp, scType, (errSum, cur) => {
      if (errSum) return res.status(500).json({ error: errSum.message });
      const totalRem = cur.remaining;
      const apply    = Math.min(parseFloat(hours) || totalRem, Math.max(0, totalRem));
      if (apply <= 0) return res.status(400).json({ error: 'No hours to apply' });

      const baseRow = cur.periodRow || rec;
      const snapUsed = toNum(baseRow.used_hours) + apply;
      const working = { ...baseRow, used_hours: snapUsed };
      const remarks =
        `service_credit_action:source_row_${id}:${action || 'offset'}`;

      recomputeScLedgerFieldsAsync(db, working).then((ledger) => {
      db.query(
        `INSERT INTO service_credit
          (employeeNumber, sc_type, ot_hours_regular, ot_hours_holiday, ot_hours_night_diff, total_ot_hours,
           earned_hours, total_hours, carried_forward_hours, remaining_hours, used_hours, earning_status,
           period_year, period_month, remarks, emp_category_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          emp,
          scType,
          toNum(baseRow.ot_hours_regular),
          toNum(baseRow.ot_hours_holiday),
          toNum(baseRow.ot_hours_night_diff),
          toNum(baseRow.total_ot_hours),
          ledger.earned_hours,
          ledger.total_hours,
          ledger.carried_forward_hours,
          ledger.remaining_hours,
          ledger.used_hours,
          ledger.earning_status,
          rec.period_year,
          rec.period_month,
          remarks,
          baseRow.emp_category_snapshot || null,
        ],
        (errIns, insRes) => {
          if (errIns) return res.status(500).json({ error: errIns.message });
          const newScId = insRes.insertId;
          const snapRem = ledger.remaining_hours;

          db.query(
            `INSERT INTO service_credit_usage
             (service_credit_id, employeeNumber, action, hours_applied, target_leave_code)
             VALUES (?,?,?,?,?)`,
            [newScId, emp, action, apply, targetLeaveCode || null],
            (err3) => { if (err3) console.error('SC audit log error:', err3); }
          );

          (async () => {
            try {
              await logScBalanceChange({
                req,
                targetEmp: emp,
                recordId: newScId,
                action: `applied action "${action}" (${toNum(apply).toFixed(3)} hrs deducted)`,
                period_year: rec.period_year,
                period_month: rec.period_month,
                balBeforeRem: totalRem,
                balAfterRem: snapRem,
                details: {
                  source_service_credit_id: id,
                  service_credit_id: newScId,
                  action,
                  hours_applied: apply,
                  target_leave_code: targetLeaveCode || null,
                },
              });
            } catch (e) {
              console.error("[service_credit] action audit:", e.message);
            }
          })();

          if ((action === 'convert_to_sl' || action === 'convert_to_vl') && targetLeaveCode) {
            db.query(
              `SELECT id, remaining_hours FROM leave_assignment
               WHERE employeeNumber = ? AND leave_code = ?
               ORDER BY period_year DESC, id DESC LIMIT 1`,
              [emp, targetLeaveCode],
              (err4, laRows) => {
                if (!err4 && laRows.length) {
                  const la       = laRows[0];
                  // Append-only: create a new leave_assignment snapshot row (do NOT update the existing row),
                  // so history stays intact (same pattern as leave earnings approvals).
                  db.query(
                    `SELECT *
                     FROM leave_assignment
                     WHERE id = ?
                     LIMIT 1`,
                    [la.id],
                    (err5, laFullRows) => {
                      if (err5 || !laFullRows?.length) return;
                      const prev = laFullRows[0];
                      const prevTotal = parseFloat(prev.total_hours) || 0;
                      const prevRem   = parseFloat(prev.remaining_hours) || 0;
                      const prevUsed  = parseFloat(prev.used_hours) || 0;
                      const prevCF    = parseFloat(prev.carried_forward_hours) || 0;
                      const prevAlloc = parseFloat(prev.allocated_hours) || 0;
                      const th = Math.max(0, prevTotal + apply);
                      const rh = Math.max(0, prevRem + apply);
                      const ah = Math.max(0, prevAlloc + apply);
                      const sem = prev.period_semester != null && prev.period_semester !== "" ? String(prev.period_semester) : null;
                      db.query(
                        `INSERT INTO leave_assignment
                          (employeeNumber, leave_code, total_hours, remaining_hours, used_hours, approve_date,
                           carried_forward_hours, allocated_hours, period_year, period_semester)
                         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                        [
                          emp,
                          targetLeaveCode,
                          th,
                          rh,
                          prevUsed,
                          prevCF,
                          ah,
                          prev.period_year || null,
                          sem,
                        ],
                        (err6) => { if (err6) console.error('LA insert snapshot error:', err6); }
                      );
                    }
                  );
                }
              }
            );
          }

          emitScChanged('updated', {
            employeeNumber: emp,
            period_year: rec.period_year,
            period_month: rec.period_month,
            action,
            hours_applied: apply,
          });
          res.json({ message: 'Action applied', hours_applied: apply, remaining_hours: snapRem });
        }
      );
      }).catch((e) => res.status(500).json({ error: e.message }));
    });
  });
});
 
// ─── POST /service_credit/:id/commute ─────────────────────────────────────────
// Legacy alias — prefer POST /commutationRoute/leave_commutation/commute-sc/:id
router.post('/service_credit/:id/commute', authenticateToken, requireAdmin, (req, res) => {
  req.params.serviceCreditId = req.params.id;
  return commuteServiceCreditPeriod(req, res);
});

module.exports = router;