const db = require('../db');
const express = require('express');
const router = express.Router();
const { notifyPayrollChanged } = require('../socket/socketService');
const { authenticateToken, requireAdmin, logAudit } = require('../middleware/auth');
const { attachEmploymentCategories } = require('../utils/employmentCategoryMerge');
// ─────────────────────────────────────────────
// UTILITY: time helpers
// ─────────────────────────────────────────────

/** Decimal hours (unpaid / salary-charged time) → HH, MM, SS strings for payroll_processing. */
function decimalHoursToClockParts(totalHours) {
  const t = Math.max(0, Number(totalHours) || 0);
  const totalSeconds = Math.round(t * 3600);
  const hNum = Math.floor(totalSeconds / 3600);
  const mNum = Math.floor((totalSeconds % 3600) / 60);
  const sNum = totalSeconds % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  return { h: pad2(hNum), m: pad2(mNum), s: pad2(sNum) };
}

const getUserDisplayName = (user) => {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : (user.username || user.employeeNumber || 'Unknown');
};

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

router.get('/test-auth', authenticateToken, requireAdmin, (req, res) => {
  res.json({
    message: 'Authentication successful',
    user: req.user,
    timestamp: new Date().toISOString(),
  });
});

router.get('/payroll', authenticateToken, requireAdmin, (req, res) => {
  const sql = 'SELECT * FROM payroll_processing WHERE rh IS NULL OR rh = ""';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

router.get('/payroll/search', authenticateToken, requireAdmin, (req, res) => {
  const { searchTerm } = req.query;

  const query = `
    SELECT
      p.id,
      p.department AS code,
      p.employeeNumber,
      p.startDate,
      p.endDate,
      p.rateNbc584,
      p.rateNbc594,
      p.nbcDiffl597,
      p.grossSalary,
      p.abs,
      p.h,
      p.m,
      p.s,
      p.netSalary,
      p.withholdingTax,
      p.personalLifeRetIns,
      p.totalGsisDeds,
      p.totalPagibigDeds,
      p.totalOtherDeds,
      p.totalDeductions,
      p.pay1st,
      p.pay2nd,
      p.pay1stCompute,
      p.pay2ndCompute,
      p.rtIns,
      p.ec,
      p.status,
      CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) AS name,
      r.nbc594,
      r.increment,
      r.gsisSalaryLoan,
      r.gsisPolicyLoan,
      r.gfal,
      r.gsisArrears,
      r.cpl,
      r.mpl,
      r.eal,
      r.mplLite,
      r.emergencyLoan,
      r.pagibigFundCont,
      r.pagibig2,
      r.multiPurpLoan,
      r.landbankSalaryLoan,
      r.earistCreditCoop,
      r.feu,
      r.gsl,
      r.gbk,
      r.liquidatingCash,
      itt.item_description AS position,
      sgt.sg_number,
      ph.PhilHealthContribution,
      da.code AS department,
      oar.overallRenderedOfficialTime,
      oar.overallRenderedOfficialTimeTardiness,
      oar.totalRenderedTimeMorning,
      oar.totalRenderedTimeMorningTardiness,
      oar.totalRenderedTimeAfternoon,
      oar.totalRenderedTimeAfternoonTardiness,
      oar.totalRenderedHonorarium,
      oar.totalRenderedHonorariumTardiness,
      oar.totalRenderedServiceCredit,
      oar.totalRenderedServiceCreditTardiness,
      oar.totalRenderedOvertime,
      oar.totalRenderedOvertimeTardiness,
      COALESCE(ec.employmentCategory, -1) AS employmentCategory,
      CASE itt.step
        WHEN 'step1' THEN sgt.step1
        WHEN 'step2' THEN sgt.step2
        WHEN 'step3' THEN sgt.step3
        WHEN 'step4' THEN sgt.step4
        WHEN 'step5' THEN sgt.step5
        WHEN 'step6' THEN sgt.step6
        WHEN 'step7' THEN sgt.step7
        WHEN 'step8' THEN sgt.step8
        ELSE NULL
      END AS rateNbc594
    FROM payroll_processing p
    LEFT JOIN person_table pt ON pt.agencyEmployeeNum = p.employeeNumber
    LEFT JOIN employment_category ec ON CAST(ec.employeeNumber AS CHAR) = CAST(p.employeeNumber AS CHAR)
    LEFT JOIN employment_type_config etc ON etc.id = ec.employmentCategory
    LEFT JOIN (
      SELECT employeeNumber, MAX(id) as max_id
      FROM remittance_table
      GROUP BY employeeNumber
    ) r_max ON p.employeeNumber = r_max.employeeNumber
    LEFT JOIN remittance_table r ON r.employeeNumber = p.employeeNumber AND r.id = r_max.max_id
    LEFT JOIN (
      SELECT employeeNumber, MAX(id) as max_id
      FROM philhealth
      GROUP BY employeeNumber
    ) ph_max ON p.employeeNumber = ph_max.employeeNumber
    LEFT JOIN philhealth ph ON ph.employeeNumber = p.employeeNumber AND ph.id = ph_max.max_id
    LEFT JOIN (
      SELECT employeeNumber, MAX(id) as max_id
      FROM department_assignment
      GROUP BY employeeNumber
    ) da_max ON p.employeeNumber = da_max.employeeNumber
    LEFT JOIN department_assignment da ON da.employeeNumber = p.employeeNumber AND da.id = da_max.max_id
    LEFT JOIN (
      SELECT employeeID, MAX(id) as max_id
      FROM item_table
      GROUP BY employeeID
    ) itt_max ON p.employeeNumber = itt_max.employeeID
    LEFT JOIN item_table itt ON itt.employeeID = p.employeeNumber AND itt.id = itt_max.max_id
    LEFT JOIN salary_grade_table sgt ON sgt.sg_number = itt.salary_grade
      AND sgt.effectivityDate = itt.effectivityDate
    LEFT JOIN (
      SELECT personID, startDate, endDate, overallRenderedOfficialTime,
             overallRenderedOfficialTimeTardiness, totalRenderedTimeMorning,
             totalRenderedTimeMorningTardiness, totalRenderedTimeAfternoon,
             totalRenderedTimeAfternoonTardiness, totalRenderedHonorarium,
             totalRenderedHonorariumTardiness, totalRenderedServiceCredit,
             totalRenderedServiceCreditTardiness, totalRenderedOvertime,
             totalRenderedOvertimeTardiness, MAX(id) AS max_id
      FROM overall_attendance_record
      GROUP BY personID, startDate, endDate
    ) oar ON oar.personID = p.employeeNumber
      AND oar.startDate = p.startDate
      AND oar.endDate = p.endDate
    WHERE (p.rh IS NULL OR p.rh = "")
      AND (
        ec.employeeNumber IS NULL
        OR (
          COALESCE(ec.employmentCategory, -1) NOT IN (0, 1)
          AND NOT (
            etc.id IS NOT NULL
            AND UPPER(TRIM(IFNULL(etc.parentGroup, ''))) = 'J0'
          )
        )
      )
      AND (
        p.employeeNumber LIKE ?
        OR CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) LIKE ?
      )
  `;

  const searchPattern = `%${searchTerm}%`;

  db.query(query, [searchPattern, searchPattern], (err, results) => {
    if (err) {
      console.error('Error searching payroll data:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json(results);
  });
});

router.get('/payroll-with-remittance', authenticateToken, requireAdmin, (req, res) => {
  const { employeeNumber, startDate, endDate, searchTerm } = req.query; // ← add searchTerm

  if (employeeNumber && startDate && endDate) {
    const checkQuery = `
      SELECT * FROM payroll_processing
      WHERE employeeNumber = ? AND startDate = ? AND endDate = ?
        AND (rh IS NULL OR rh = "")
    `;
    db.query(
      checkQuery,
      [employeeNumber, startDate, endDate],
      (err, result) => {
        if (err) {
          console.error('Error checking existing payroll data:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        return res.json({ exists: result.length > 0 });
      },
    );
  } else {
    let baseQuery = `
      SELECT
        p.id,
        p.department AS code,
        p.employeeNumber,
        p.startDate,
        p.endDate,
        p.rateNbc584,
        p.rateNbc594,
        p.nbcDiffl597,
        p.grossSalary,
        p.abs,
        p.h,
        p.m,
        p.s,
        p.netSalary,
        p.withholdingTax,
        p.personalLifeRetIns,
        p.totalGsisDeds,
        p.totalPagibigDeds,
        p.totalOtherDeds,
        p.totalDeductions,
        p.pay1st,
        p.pay2nd,
        p.pay1stCompute,
        p.pay2ndCompute,
        p.rtIns,
        p.ec,
        p.status,
        CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) AS name,
        r.nbc594,
        r.increment,
        r.gsisSalaryLoan,
        r.gsisPolicyLoan,
        r.gfal,
        r.gsisArrears,
        r.cpl,
        r.mpl,
        r.eal,
        r.mplLite,
        r.emergencyLoan,
        r.pagibigFundCont,
        r.pagibig2,
        r.multiPurpLoan,
        r.landbankSalaryLoan,
        r.earistCreditCoop,
        r.feu,
        r.rel,
        r.gsl,
        r.gbk,
        r.liquidatingCash,
        itt.item_description AS position,
        sgt.sg_number,
        ph.PhilHealthContribution,
        da.code AS department,
        oar.overallRenderedOfficialTime,
        oar.overallRenderedOfficialTimeTardiness,
        oar.totalRenderedTimeMorning,
        oar.totalRenderedTimeMorningTardiness,
        oar.totalRenderedTimeAfternoon,
        oar.totalRenderedTimeAfternoonTardiness,
        oar.totalRenderedHonorarium,
        oar.totalRenderedHonorariumTardiness,
        oar.totalRenderedServiceCredit,
        oar.totalRenderedServiceCreditTardiness,
        oar.totalRenderedOvertime,
        oar.totalRenderedOvertimeTardiness,
        COALESCE(ec.employmentCategory, -1) AS employmentCategory,
        CASE itt.step
          WHEN 'step1' THEN sgt.step1
          WHEN 'step2' THEN sgt.step2
          WHEN 'step3' THEN sgt.step3
          WHEN 'step4' THEN sgt.step4
          WHEN 'step5' THEN sgt.step5
          WHEN 'step6' THEN sgt.step6
          WHEN 'step7' THEN sgt.step7
          WHEN 'step8' THEN sgt.step8
          ELSE NULL
        END AS rateNbc594
      FROM payroll_processing p
      LEFT JOIN person_table pt ON pt.agencyEmployeeNum = p.employeeNumber
      LEFT JOIN employment_category ec ON CAST(ec.employeeNumber AS CHAR) = CAST(p.employeeNumber AS CHAR)
      LEFT JOIN employment_type_config etc ON etc.id = ec.employmentCategory
      LEFT JOIN (
        SELECT employeeNumber, MAX(id) as max_id
        FROM remittance_table
        GROUP BY employeeNumber
      ) r_max ON p.employeeNumber = r_max.employeeNumber
      LEFT JOIN remittance_table r ON r.employeeNumber = p.employeeNumber AND r.id = r_max.max_id
      LEFT JOIN (
        SELECT employeeNumber, MAX(id) as max_id
        FROM philhealth
        GROUP BY employeeNumber
      ) ph_max ON p.employeeNumber = ph_max.employeeNumber
      LEFT JOIN philhealth ph ON ph.employeeNumber = p.employeeNumber AND ph.id = ph_max.max_id
      LEFT JOIN (
        SELECT employeeNumber, MAX(id) as max_id
        FROM department_assignment
        GROUP BY employeeNumber
      ) da_max ON p.employeeNumber = da_max.employeeNumber
      LEFT JOIN department_assignment da ON da.employeeNumber = p.employeeNumber AND da.id = da_max.max_id
      LEFT JOIN (
        SELECT employeeID, MAX(id) as max_id
        FROM item_table
        GROUP BY employeeID
      ) itt_max ON p.employeeNumber = itt_max.employeeID
      LEFT JOIN item_table itt ON itt.employeeID = p.employeeNumber AND itt.id = itt_max.max_id
      LEFT JOIN salary_grade_table sgt ON sgt.sg_number = itt.salary_grade
        AND sgt.effectivityDate = itt.effectivityDate
      LEFT JOIN (
        SELECT personID, startDate, endDate, overallRenderedOfficialTime,
               overallRenderedOfficialTimeTardiness, totalRenderedTimeMorning,
               totalRenderedTimeMorningTardiness, totalRenderedTimeAfternoon,
               totalRenderedTimeAfternoonTardiness, totalRenderedHonorarium,
               totalRenderedHonorariumTardiness, totalRenderedServiceCredit,
               totalRenderedServiceCreditTardiness, totalRenderedOvertime,
               totalRenderedOvertimeTardiness, MAX(id) AS max_id
        FROM overall_attendance_record
        GROUP BY personID, startDate, endDate
      ) oar ON oar.personID = p.employeeNumber
        AND oar.startDate = p.startDate
        AND oar.endDate = p.endDate
      WHERE (p.rh IS NULL OR p.rh = "")
        AND (
          ec.employeeNumber IS NULL
          OR (
            COALESCE(ec.employmentCategory, -1) NOT IN (0, 1)
            AND NOT (
              etc.id IS NOT NULL
              AND UPPER(TRIM(IFNULL(etc.parentGroup, ''))) = 'J0'
            )
          )
        )
    `;

    const queryParams = [];

    // ← Add search filter if searchTerm is provided
    if (searchTerm) {
      baseQuery += ` AND (
        p.employeeNumber LIKE ?
        OR CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) LIKE ?
      )`;
      const searchPattern = `%${searchTerm}%`;
      queryParams.push(searchPattern, searchPattern);
    }

    db.query(baseQuery, queryParams, (err, results) => {
      if (err) {
        console.error('Error fetching joined payroll data:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json(results);
    });
  }
});

router.put(
  '/payroll-with-remittance/:employeeNumber/:startDate/:endDate',
  authenticateToken,
  requireAdmin,
  (req, res) => {
    const { employeeNumber, startDate, endDate } = req.params;
    const {
      name,
      rateNbc584,
      rateNbc594,
      nbcDiffl597,
      grossSalary,
      abs,
      h,
      m,
      s,
      netSalary,
      withholdingTax,
      personalLifeRetIns,
      totalGsisDeds,
      totalPagibigDeds,
      totalOtherDeds,
      totalDeductions,
      pay1st,
      pay2nd,
      pay1stCompute,
      pay2ndCompute,
      rtIns,
      ec,
      nbc594,
      increment,
      gsisSalaryLoan,
      gsisPolicyLoan,
      gfal,
      gsisArrears,
      cpl,
      mpl,
      eal,
      mplLite,
      emergencyLoan,
      pagibigFundCont,
      pagibig2,
      multiPurpLoan,
      position,
      liquidatingCash,
      landbankSalaryLoan,
      earistCreditCoop,
      feu,
      rel,
      gsl,
      gbk,
      PhilHealthContribution,
      department,
    } = req.body;

    const nameExtensionCandidates = ['Jr.', 'Sr.', 'II', 'III', 'IV'];
    let lastName = '';
    let firstName = '';
    let middleName = '';
    let nameExtension = '';

    if (typeof name === 'string') {
      const [last, firstMiddle] = name.split(',').map((part) => part.trim());
      if (last && firstMiddle) {
        lastName = last;
        const nameParts = firstMiddle.split(' ').filter(Boolean);
        if (nameParts.length > 0) {
          firstName = nameParts[0];
          const middleParts = [];
          for (let i = 1; i < nameParts.length; i++) {
            if (nameExtensionCandidates.includes(nameParts[i])) {
              nameExtension = nameParts[i];
            } else {
              middleParts.push(nameParts[i]);
            }
          }
          middleName = middleParts.join(' ');
        }
      }
    } else {
      console.error('Invalid name input:', name);
    }

    const payrollQuery = `
      UPDATE payroll_processing p
      LEFT JOIN item_table itt ON p.employeeNumber = itt.employeeID
      SET
        p.department = ?,
        p.name = ?,
        itt.item_description = ?,
        p.rateNbc584 = ?,
        p.rateNbc594 = ?,
        p.nbcDiffl597 = ?,
        p.grossSalary = ?,
        p.abs = ?,
        p.h = ?,
        p.m = ?,
        p.s = ?,
        p.netSalary = ?,
        p.withholdingTax = ?,
        p.personalLifeRetIns = ?,
        p.totalGsisDeds = ?,
        p.totalPagibigDeds = ?,
        p.totalOtherDeds = ?,
        p.totalDeductions = ?,
        p.pay1st = ?,
        p.pay2nd = ?,
        p.pay1stCompute = ?,
        p.pay2ndCompute = ?,
        p.rtIns = ?,
        p.ec = ?
      WHERE p.employeeNumber = ? AND p.startDate = ? AND p.endDate = ?
    `;

    const payrollValues = [
      department,
      name,
      position,
      rateNbc584,
      rateNbc594,
      nbcDiffl597,
      grossSalary,
      abs,
      h,
      m,
      s,
      netSalary,
      withholdingTax,
      personalLifeRetIns,
      totalGsisDeds,
      totalPagibigDeds,
      totalOtherDeds,
      totalDeductions,
      pay1st,
      pay2nd,
      pay1stCompute,
      pay2ndCompute,
      rtIns,
      ec,
      employeeNumber,
      startDate,
      endDate,
    ];

    db.query(payrollQuery, payrollValues, (err, result) => {
      if (err) {
        console.error('Error updating payroll data:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Employee not found' });
      }

      const getIdQuery =
        'SELECT id FROM payroll_processing WHERE employeeNumber = ? AND startDate = ? AND endDate = ? LIMIT 1';
      db.query(
        getIdQuery,
        [employeeNumber, startDate, endDate],
        (idErr, idResult) => {
          const checkRemittanceQuery = `
          SELECT id FROM remittance_table
          WHERE employeeNumber = ?
          ORDER BY id DESC LIMIT 1
        `;

          db.query(
            checkRemittanceQuery,
            [employeeNumber],
            (err2, checkResult) => {
              if (err2) {
                console.error('Error checking existing remittance:', err2);
                return res.status(500).json({ error: 'Internal server error' });
              }

              const remittanceValues = [
                nbc594 || 0,
                increment || 0,
                gsisSalaryLoan || 0,
                gsisPolicyLoan || 0,
                gfal || 0,
                gsisArrears || 0,
                cpl || 0,
                mpl || 0,
                eal || 0,
                mplLite || 0,
                emergencyLoan || 0,
                pagibigFundCont || 0,
                pagibig2 || 0,
                multiPurpLoan || 0,
                liquidatingCash || 0,
                landbankSalaryLoan || 0,
                earistCreditCoop || 0,
                feu || 0,
                rel || 0,
                gsl || 0,
                gbk || 0,
              ];

              if (checkResult.length > 0) {
                const updateRemittanceQuery = `
              UPDATE remittance_table SET
                nbc594 = ?, increment = ?,
                gsisSalaryLoan = ?, gsisPolicyLoan = ?, gfal = ?, gsisArrears = ?,
                cpl = ?, mpl = ?, eal = ?, mplLite = ?, emergencyLoan = ?,
                pagibigFundCont = ?, pagibig2 = ?, multiPurpLoan = ?,
                liquidatingCash = ?, landbankSalaryLoan = ?,
                earistCreditCoop = ?, feu = ?, rel = ?, gsl = ?, gbk = ?
              WHERE employeeNumber = ?
            `;
                db.query(
                  updateRemittanceQuery,
                  [...remittanceValues, employeeNumber],
                  (err3) => {
                    if (err3) {
                      console.error('Error updating remittance data:', err3);
                      return res
                        .status(500)
                        .json({ error: 'Internal server error' });
                    }
                    proceedWithPersonUpdate();
                  },
                );
              } else {
                const insertRemittanceQuery = `
              INSERT INTO remittance_table (
                employeeNumber, nbc594, increment,
                gsisSalaryLoan, gsisPolicyLoan, gfal, gsisArrears,
                cpl, mpl, eal, mplLite, emergencyLoan,
                pagibigFundCont, pagibig2, multiPurpLoan,
                liquidatingCash, landbankSalaryLoan,
                earistCreditCoop, feu, rel, gsl, gbk
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
                db.query(
                  insertRemittanceQuery,
                  [employeeNumber, ...remittanceValues],
                  (err3) => {
                    if (err3) {
                      console.error('Error inserting remittance data:', err3);
                      return res
                        .status(500)
                        .json({ error: 'Internal server error' });
                    }
                    proceedWithPersonUpdate();
                  },
                );
              }

              function proceedWithPersonUpdate() {
                const personQuery = `
              UPDATE person_table
              SET firstName = ?, middleName = ?, lastName = ?, nameExtension = ?
              WHERE agencyEmployeeNum = ?
            `;
                db.query(
                  personQuery,
                  [
                    firstName,
                    middleName,
                    lastName,
                    nameExtension,
                    employeeNumber,
                  ],
                  (err3) => {
                    if (err3) {
                      console.error('Error updating person name:', err3);
                      return res
                        .status(500)
                        .json({ error: 'Internal server error' });
                    }

                    db.query(
                      'UPDATE philhealth SET PhilHealthContribution = ? WHERE employeeNumber = ?',
                      [PhilHealthContribution, employeeNumber],
                      (err4) => {
                        if (err4) {
                          console.error('Error updating PhilHealth:', err4);
                          return res
                            .status(500)
                            .json({ error: 'Internal server error' });
                        }

                        db.query(
                          'UPDATE department_assignment SET code = ? WHERE employeeNumber = ?',
                          [department, employeeNumber],
                          (err5) => {
                            if (err5) {
                              console.error('Error updating department:', err5);
                              return res
                                .status(500)
                                .json({ error: 'Internal server error' });
                            }

                            notifyPayrollChanged('updated', {
                              module: 'payroll-processing',
                              employeeNumber,
                            });
                            try {
                              logAudit(req.user, 'UPDATE', 'payroll_processing', employeeNumber, employeeNumber);
                            } catch (e) { console.error('Audit log error:', e); }
                            res.json({
                              message: 'Payroll record updated successfully',
                            });
                          },
                        );
                      },
                    );
                  },
                );
              }
            },
          );
        },
      );
    });
  },
);

router.delete(
  '/payroll-with-remittance/:id/:employeeNumber',
  authenticateToken,
  requireAdmin,
  (req, res) => {
    const { id, employeeNumber } = req.params;

    const query = `
      DELETE FROM payroll_processing
      WHERE id = ? AND employeeNumber = ?
    `;

    db.query(query, [id, employeeNumber], (err, result) => {
      if (err) {
        console.error('Error deleting payroll data:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (result.affectedRows === 0) {
        return res
          .status(404)
          .json({ error: 'Payroll record not found or employee mismatch' });
      }

      notifyPayrollChanged('deleted', {
        module: 'payroll-processing',
        id,
        employeeNumber,
      });
      try {
        logAudit(req.user, 'DELETE', 'payroll_processing', id, employeeNumber);
      } catch (e) { console.error('Audit log error:', e); }
      res.json({ message: 'Payroll record deleted successfully' });
    });
  },
);

router.post('/add-rendered-time', authenticateToken, requireAdmin, async (req, res) => {
  const attendanceData = req.body;

  if (!Array.isArray(attendanceData)) {
    return res.status(400).json({ error: 'Expected an array of data.' });
  }

  let newCount = 0;

  try {
    for (const record of attendanceData) {
      const { employeeNumber, startDate, endDate } = record;

      const [departmentRows] = await db
        .promise()
        .query(
          'SELECT code FROM department_assignment WHERE employeeNumber = ? ORDER BY id DESC LIMIT 1',
          [employeeNumber],
        );

      if (departmentRows.length === 0) {
        return res
          .status(404)
          .json({
            error: `Department not found for employee ${employeeNumber}.`,
          });
      }

      const departmentCode = departmentRows[0].code;

      let displayName = null;
      try {
        const [personRows] = await db.promise().query(
          `SELECT CONCAT_WS(', ', pt.lastName, CONCAT_WS(' ', pt.firstName, pt.middleName, pt.nameExtension)) AS display_name
           FROM person_table pt
           WHERE pt.agencyEmployeeNum = ?
           LIMIT 1`,
          [employeeNumber],
        );
        if (personRows.length > 0 && personRows[0].display_name) {
          displayName = String(personRows[0].display_name).trim() || null;
        }
      } catch (e) {
        console.error('[add-rendered-time] person name lookup:', e.message);
      }

      /**
       * abs + h/m/s from attendance_result (earnings path), not overall_attendance tardiness.
       * - abs: SUM(unpaid_hours) / 8
       * - h,m,s: SUM(unpaid_hours) as clock (e.g. 8.5h charged to salary → 08:30:00); 0 if fully covered by leave
       */
      let absDays = 0;
      let unpaidHoursForClock = 0;
      try {
        const [arRows] = await db.promise().query(
          `SELECT
             COALESCE(SUM(ar.unpaid_hours), 0) / 8 AS abs_days,
             COALESCE(SUM(ar.unpaid_hours), 0) AS unpaid_hours_total
           FROM attendance_result ar
           WHERE TRIM(CAST(ar.employee_number AS CHAR)) = TRIM(CAST(? AS CHAR))
             AND ar.result_date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)`,
          [employeeNumber, startDate, endDate],
        );
        if (arRows.length > 0 && arRows[0]) {
          const ad = Number(arRows[0].abs_days);
          absDays = Number.isFinite(ad) ? ad : 0;
          const uh = Number(arRows[0].unpaid_hours_total);
          unpaidHoursForClock = Number.isFinite(uh) ? uh : 0;
        }
      } catch (e) {
        if (!String(e.message || "").includes("attendance_result")) {
          console.error("[add-rendered-time] attendance_result:", e.message);
        }
        try {
          const [shortfallRows] = await db.promise().query(
            `SELECT COALESCE(SUM(lss.shortfall_days), 0) AS abs_days
             FROM leave_salary_shortfall lss
             WHERE TRIM(CAST(lss.employee_number AS CHAR)) = TRIM(CAST(? AS CHAR))
               AND TRIM(IFNULL(lss.entry_type, '')) <> 'No Deduction'
               AND lss.shortfall_days > 0
               AND (
                 (
                   lss.reference_date IS NOT NULL
                   AND CAST(lss.reference_date AS CHAR) NOT IN ('0000-00-00', '1970-01-01')
                   AND lss.reference_date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
                 )
                 OR (
                   LAST_DAY(STR_TO_DATE(CONCAT(lss.period_year, '-', LPAD(lss.period_month, 2, '0'), '-01'), '%Y-%m-%d'))
                     >= CAST(? AS DATE)
                   AND STR_TO_DATE(CONCAT(lss.period_year, '-', LPAD(lss.period_month, 2, '0'), '-01'), '%Y-%m-%d')
                     <= CAST(? AS DATE)
                 )
               )`,
            [employeeNumber, startDate, endDate, startDate, endDate],
          );
          if (shortfallRows.length > 0 && shortfallRows[0].abs_days != null) {
            const n = Number(shortfallRows[0].abs_days);
            absDays = Number.isFinite(n) ? n : 0;
          }
        } catch (e2) {
          console.error("[add-rendered-time] leave_salary_shortfall sum (fallback):", e2.message);
        }
        unpaidHoursForClock = 0;
      }

      const bodyName =
        typeof record.name === 'string' && String(record.name).trim()
          ? String(record.name).trim()
          : null;
      const bodyAbsRaw = record.abs ?? record.absent;
      let bodyAbs = null;
      if (bodyAbsRaw !== undefined && bodyAbsRaw !== null && bodyAbsRaw !== '') {
        const n = Number(bodyAbsRaw);
        if (Number.isFinite(n)) bodyAbs = n;
      }

      const nameForRow = bodyName || displayName;
      const absForRow = bodyAbs !== null ? bodyAbs : absDays;

      /**
       * When the client sends explicit `abs` (ABSTRACT / selective send), clock fields must match that
       * slice only — not SUM(attendance_result) for the whole period, or payroll shows both lines' time
       * while `abs` reflected only the first selection.
       */
      const clockHoursForInsert =
        bodyAbs !== null && Number.isFinite(Number(bodyAbs))
          ? Math.max(0, Number(bodyAbs)) * 8
          : unpaidHoursForClock;
      const { h, m, s } = decimalHoursToClockParts(clockHoursForInsert);

      const [existingRows] = await db
        .promise()
        .query(
          'SELECT id, rh, rm, rs, abs FROM payroll_processing WHERE employeeNumber = ? AND startDate = ? AND endDate = ? LIMIT 5',
          [employeeNumber, startDate, endDate],
        );

      console.log(`[add-rendered-time] emp=${employeeNumber} start=${startDate} end=${endDate} | found rows:`, JSON.stringify(existingRows));

      const hasRegularRecord = existingRows.some(
        (row) => row.rh === null || row.rh === '' || row.rh === 0,
      );

      if (!hasRegularRecord) {
        await db
          .promise()
          .query(
            'INSERT INTO payroll_processing (employeeNumber, startDate, endDate, h, m, s, rh, rm, rs, department, name, abs) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)',
            [employeeNumber, startDate, endDate, h, m, s, departmentCode, nameForRow, absForRow],
          );
        newCount++;

        // ── audit log per new record ──────────────────────────────────────
        try {
          logAudit(req.user, 'ADD', 'payroll_processing', employeeNumber, employeeNumber);
        } catch (e) { console.error('Audit log error:', e); }
      } else if (bodyAbs !== null && Number(bodyAbs) > 0) {
        /** Incremental ABSTRACT sends: add only the selected rows' abs onto the existing regular payroll row. */
        const reg = existingRows.find(
          (row) => row.rh === null || row.rh === '' || row.rh === 0,
        );
        if (reg && reg.id != null) {
          const prevAbs = Number(reg.abs);
          const prevA = Number.isFinite(prevAbs) ? prevAbs : 0;
          const addAbs = Number(bodyAbs);
          const addA = Number.isFinite(addAbs) ? addAbs : 0;
          if (addA > 0) {
            const newAbs = prevA + addA;
            const totalHours = newAbs * 8;
            const clock = decimalHoursToClockParts(totalHours);
            await db
              .promise()
              .query(
                'UPDATE payroll_processing SET abs = ?, h = ?, m = ?, s = ?, name = COALESCE(?, name) WHERE id = ?',
                [newAbs, clock.h, clock.m, clock.s, nameForRow, reg.id],
              );
            newCount++;
            try {
              logAudit(req.user, 'UPDATE', 'payroll_processing', reg.id, employeeNumber);
            } catch (e) { console.error('Audit log error:', e); }
          }
        }
      }

    }

    notifyPayrollChanged('imported', {
      module: 'payroll-processing',
      count: newCount,
    });
    try {
      logAudit(req.user, 'ADD', 'payroll_processing', null, null);
    } catch (e) { console.error('Audit log error:', e); }
    res
      .status(200)
      .json({ message: 'Records added to payroll with time data.', newCount, totalSubmitted: attendanceData.length });
  } catch (err) {
    console.error('Error inserting into payroll:', err);
    res.status(500).json({ error: 'Failed to insert payroll records.' });
  }
});

// ─────────────────────────────────────────────
// GET payroll-processed
// ─────────────────────────────────────────────

router.get('/payroll-processed', authenticateToken, requireAdmin, (req, res) => {
  // Categories are merged in JS: the old CAST(...) = CAST(...) join compared
  // every payroll row with every employment_category row.
  const query = `
    SELECT pp.*, -1 AS employmentCategory
    FROM payroll_processed pp
    ORDER BY pp.dateCreated DESC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching payroll processed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    attachEmploymentCategories(results, (rows) => res.json(rows));
  });
});


router.post('/payroll-processed', authenticateToken, requireAdmin, async (req, res) => {
  const payrollData = req.body;

  if (!Array.isArray(payrollData) || payrollData.length === 0) {
    return res.status(400).json({ error: 'No payroll data received.' });
  }

  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    const values = payrollData.map((entry) => [
      entry.employeeNumber,
      entry.startDate,
      entry.endDate,
      entry.name,
      entry.rateNbc584,
      entry.nbc594,
      entry.rateNbc594,
      entry.nbcDiffl597,
      entry.grossSalary,
      entry.abs,
      entry.h ?? 0,
      entry.m ?? 0,
      entry.s ?? 0,
      entry.rh ?? 0,
      entry.netSalary,
      entry.withholdingTax,
      entry.personalLifeRetIns,
      entry.totalGsisDeds,
      entry.totalPagibigDeds,
      entry.totalOtherDeds,
      entry.totalDeductions,
      entry.pay1st,
      entry.pay2nd,
      entry.pay1stCompute,
      entry.pay2ndCompute,
      entry.rtIns,
      entry.ec,
      entry.increment,
      entry.gsisSalaryLoan,
      entry.gsisPolicyLoan,
      entry.gfal,
      entry.gsisArrears,
      entry.cpl,
      entry.mpl,
      entry.eal,
      entry.mplLite,
      entry.emergencyLoan,
      entry.pagibigFundCont,
      entry.pagibig2,
      entry.multiPurpLoan,
      entry.position,
      entry.liquidatingCash,
      entry.landbankSalaryLoan,
      entry.earistCreditCoop,
      entry.feu,
      entry.rel,
      entry.gsl,
      entry.gbk,
      entry.PhilHealthContribution,
      entry.department,
    ]);

    const insertQuery = `
      INSERT INTO payroll_processed (
        employeeNumber, startDate, endDate, name,
        rateNbc584, nbc594, rateNbc594, nbcDiffl597, grossSalary,
        abs, h, m, s,
        rh, netSalary, withholdingTax, personalLifeRetIns,
        totalGsisDeds, totalPagibigDeds, totalOtherDeds,
        totalDeductions, pay1st, pay2nd,
        pay1stCompute, pay2ndCompute, rtIns, ec, increment,
        gsisSalaryLoan, gsisPolicyLoan, gfal, gsisArrears,
        cpl, mpl, eal, mplLite, emergencyLoan,
        pagibigFundCont, pagibig2, multiPurpLoan,
        position, liquidatingCash, landbankSalaryLoan,
        earistCreditCoop, feu, rel, gsl, gbk, PhilHealthContribution, department
      ) VALUES ?
    `;

    await connection.query(insertQuery, [values]);

    for (const entry of payrollData) {
      await connection.query(
        `UPDATE payroll_processing
         SET status = 1
         WHERE employeeNumber = ? AND startDate = ? AND endDate = ?`,
        [entry.employeeNumber, entry.startDate, entry.endDate],
      );
    }

    await connection.commit();

    try {
      logAudit(req.user, 'ADD', 'payroll_processed', null, null);
    } catch (e) { console.error('Audit log error:', e); }

    res.json({
      message: 'Payroll finalized successfully.',
      processedCount: payrollData.length,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error finalizing payroll:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    connection.release();
  }
});

// ─────────────────────────────────────────────
// DELETE payroll-processed/:id
// ─────────────────────────────────────────────

router.delete('/payroll-processed/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      'SELECT employeeNumber, startDate, endDate FROM payroll_processed WHERE id = ? LIMIT 1',
      [id],
    );

    if (!rows || rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Payroll record not found' });
    }

    const { employeeNumber, startDate, endDate } = rows[0];

    // ── Delete the record ────────────────────────────────────────────────
    await connection.query('DELETE FROM payroll_processed WHERE id = ?', [id]);

    // ── Revert payroll_processing status ────────────────────────────────
    await connection.query(
      `UPDATE payroll_processing
       SET status = 0
       WHERE employeeNumber = ? AND startDate = ? AND endDate = ?`,
      [employeeNumber, startDate, endDate],
    );

    await connection.commit();

    notifyPayrollChanged('deleted', { module: 'payroll-processed', id });

    try {
      logAudit(req.user, 'DELETE', 'payroll_processed', id, employeeNumber);
    } catch (e) { console.error('Audit log error:', e); }

    res.json({
      message: 'Payroll record deleted and status reverted.',
      deleted: 1,
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting payroll processed:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    connection.release();
  }
});

module.exports = router;
