const db = require("../db");
const express = require('express');
const router = express.Router();
const { notifyPayrollChanged } = require('../socket/socketService');
const { authenticateToken, logAudit, requireAdmin, isAdminRole } = require('../middleware/auth');
const { attachEmploymentCategories } = require('../utils/employmentCategoryMerge');





// GET all released payroll records
router.get('/released-payroll', authenticateToken, requireAdmin, (req, res) => {
  const query = 'SELECT * FROM payroll_released ORDER BY dateReleased DESC';


  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching released payroll:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }


    // Audit log: viewing released payroll
    res.json(results);
  });
});


// GET released payroll with detailed joins (for payslip components)
router.get('/released-payroll-detailed', authenticateToken, (req, res) => {
  const scopedEmployee = isAdminRole(req.user?.role)
    ? null
    : String(req.user?.employeeNumber || '').trim();

  if (!isAdminRole(req.user?.role) && !scopedEmployee) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Staff (Home / Payslip, every employee): compare bare columns to the bound
  // employee number so the payroll_released and employment_category indexes are
  // used. The CAST(col AS CHAR) forms scanned the whole payroll history.
  // Admins (all employees): the old CAST(...) = CAST(...) join compared every
  // payroll row with every employment_category row and ran for minutes on a
  // year of payroll; categories are merged in JS instead (attachEmploymentCategories).
  const employeeClause = scopedEmployee ? 'WHERE pr.employeeNumber = ?' : '';
  const categoryJoin = scopedEmployee
    ? 'LEFT JOIN employment_category ec ON ec.employeeNumber = ?'
    : '';
  const categorySelect = scopedEmployee
    ? 'COALESCE(ec.employmentCategory, -1) AS employmentCategory'
    : '-1 AS employmentCategory';
  const queryParams = scopedEmployee ? [scopedEmployee] : [];
  const joinedQueryParams = scopedEmployee ? [scopedEmployee, scopedEmployee] : [];

  const query = `
    SELECT
      pr.*,
      ${categorySelect}
    FROM payroll_released pr
    ${categoryJoin}
    ${employeeClause}
    ORDER BY pr.dateReleased DESC
  `;

  db.query(query, joinedQueryParams, (err, results) => {
    if (err) {
      console.error('Error fetching detailed released payroll:', err);
      console.error('Error details:', {
        message: err.message,
        code: err.code,
        sqlState: err.sqlState,
        sqlMessage: err.sqlMessage
      });
      
      // Try fallback query without JOIN if the JOIN fails
      console.log('Attempting fallback query without employment_category JOIN...');
      const fallbackQuery = `
        SELECT
          pr.*,
          -1 AS employmentCategory
        FROM payroll_released pr
        ${employeeClause}
        ORDER BY pr.dateReleased DESC
      `;
      
      db.query(fallbackQuery, queryParams, (fallbackErr, fallbackResults) => {
        if (fallbackErr) {
          console.error('Fallback query also failed:', fallbackErr);
          const errorResponse = {
            error: 'Internal server error',
            message: 'Failed to fetch detailed released payroll data'
          };
          
          if (process.env.NODE_ENV === 'development') {
            errorResponse.details = err.message;
            errorResponse.code = err.code;
            errorResponse.fallbackError = fallbackErr.message;
          }
          
          return res.status(500).json(errorResponse);
        }
        
        // Success with fallback - return results with default employmentCategory
        console.log('Fallback query succeeded, returning results without employmentCategory data');
        
        return res.json(fallbackResults);
      });
      
      return; // Exit early, fallback query will handle response
    }

    // Audit log: viewing detailed released payroll (non-blocking)
    // Don't let audit logging failure prevent the response

    if (!scopedEmployee) {
      return attachEmploymentCategories(results, (rows) => res.json(rows));
    }
    res.json(results);
  });
});


// POST - Release payroll records (move from finalized to released)
// POST - Release payroll records (copy from finalized to released, don't delete)
router.post('/release-payroll', authenticateToken, requireAdmin, (req, res) => {
  const { payrollIds, releasedBy } = req.body;


  if (!payrollIds || !Array.isArray(payrollIds) || payrollIds.length === 0) {
    return res
      .status(400)
      .json({ error: 'No payroll IDs provided for release.' });
  }


  // Get the payroll data from payroll_processed (both regular and JO records are in the same table)
  const getPayrollQuery = 'SELECT * FROM payroll_processed WHERE id IN (?)';

  db.query(getPayrollQuery, [payrollIds], (err, payrollData) => {
    if (err) {
      console.error('Error fetching payroll data:', err);
      console.error('Error details:', {
        message: err.message,
        code: err.code,
        sqlState: err.sqlState,
        payrollIds: payrollIds
      });
      return res.status(500).json({ 
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }

    if (payrollData.length === 0) {
      return res
        .status(404)
        .json({ error: 'No payroll records found to release.' });
    }

    // Check if any of these records are already released
    // Build query with OR conditions to check for specific combinations
    const placeholders = payrollData.map(() => '(employeeNumber = ? AND startDate = ? AND endDate = ?)').join(' OR ');
    const checkReleasedQuery = `
      SELECT employeeNumber, startDate, endDate 
      FROM payroll_released 
      WHERE ${placeholders}
    `;
    
    // Flatten the parameters for the query
    const checkParams = payrollData.flatMap((record) => [
      record.employeeNumber,
      record.startDate,
      record.endDate,
    ]);


    db.query(
      checkReleasedQuery,
      checkParams,
      (checkErr, existingReleased) => {
        if (checkErr) {
          console.error('Error checking existing released records:', checkErr);
          console.error('Error details:', {
            message: checkErr.message,
            code: checkErr.code,
            sqlState: checkErr.sqlState,
            sqlMessage: checkErr.sqlMessage,
            payrollIds: payrollIds
          });
          return res.status(500).json({ 
            error: 'Internal server error',
            details: process.env.NODE_ENV === 'development' ? checkErr.message : undefined
          });
        }


        // Filter out already released records
        const alreadyReleasedKeys = new Set(
          existingReleased.map(
            (record) =>
              `${record.employeeNumber}-${record.startDate}-${record.endDate}`
          )
        );


        const recordsToRelease = payrollData.filter(
          (record) =>
            !alreadyReleasedKeys.has(
              `${record.employeeNumber}-${record.startDate}-${record.endDate}`
            )
        );


        if (recordsToRelease.length === 0) {
          return res
            .status(400)
            .json({ error: 'All selected records are already released.' });
        }


        // Prepare data for insertion into payroll_released
        const values = recordsToRelease.map((record) => [
          record.employeeNumber,
          record.startDate,
          record.endDate,
          record.name,
          record.rateNbc584,
          record.nbc594,
          record.rateNbc594,
          record.nbcDiffl597,
          record.grossSalary,
          record.abs,
          record.h,
          record.m,
          record.s,
          record.netSalary,
          record.withholdingTax,
          record.personalLifeRetIns,
          record.totalGsisDeds,
          record.totalPagibigDeds,
          record.totalOtherDeds,
          record.totalDeductions,
          record.pay1st,
          record.pay2nd,
          record.pay1stCompute,
          record.pay2ndCompute,
          record.rtIns,
          record.ec,
          record.increment,
          record.gsisSalaryLoan,
          record.gsisPolicyLoan,
          record.gsisArrears,
          record.cpl,
          record.mpl,
          record.eal,
          record.mplLite,
          record.emergencyLoan,
          record.pagibigFundCont,
          record.pagibig2,
          record.multiPurpLoan,
          record.position,
          record.liquidatingCash,
          record.landbankSalaryLoan,
          record.earistCreditCoop,
          record.feu,
          record.PhilHealthContribution,
          record.department,
          record.rh,
          record.sss,
          releasedBy || req.user.employeeNumber,
        ]);


        const insertQuery = `
        INSERT INTO payroll_released (
          employeeNumber, startDate, endDate, name, rateNbc584, nbc594, rateNbc594, nbcDiffl597, grossSalary,
          abs, h, m, s, netSalary, withholdingTax, personalLifeRetIns, totalGsisDeds,
          totalPagibigDeds, totalOtherDeds, totalDeductions, pay1st, pay2nd,
          pay1stCompute, pay2ndCompute, rtIns, ec, increment, gsisSalaryLoan,
          gsisPolicyLoan, gsisArrears, cpl, mpl, eal, mplLite, emergencyLoan,
          pagibigFundCont, pagibig2, multiPurpLoan, position, liquidatingCash,
          landbankSalaryLoan, earistCreditCoop, feu, PhilHealthContribution, department, rh, sss, releasedBy
        ) VALUES ?
      `;


        db.query(insertQuery, [values], (err, result) => {
          if (err) {
            console.error('Error inserting released payroll:', err);
            console.error('Error details:', {
              message: err.message,
              code: err.code,
              sqlState: err.sqlState,
              sqlMessage: err.sqlMessage,
              payrollIds: payrollIds,
              recordsCount: recordsToRelease.length
            });
            logAudit(
              req.user,
              'CREATE_FAILED',
              'payroll_released',
              null,
              recordsToRelease.map(r => r.employeeNumber).join(', ')
            );
            return res.status(500).json({ 
              error: 'Internal server error',
              details: process.env.NODE_ENV === 'development' ? err.message : undefined
            });
          }


          // Log successful insertion — one audit entry per released employee
          for (const record of recordsToRelease) {
            logAudit(
              req.user,
              'CREATE',
              'payroll_released',
              record.id,
              record.employeeNumber
            );
          }

          notifyPayrollChanged('released', {
            module: 'payroll-released',
            releasedCount: result.affectedRows,
            payrollIds,
          });


          // IMPORTANT: Don't delete from payroll_processed - just copy to payroll_released
          // The records should remain in payroll_processed for the PayrollProcessed view


          res.json({
            message: 'Payroll records released successfully.',
            released: result.affectedRows,
            alreadyReleased: payrollData.length - recordsToRelease.length,
          });
        });
      }
    );
  });
});


// GET single released payroll record
router.get('/released-payroll/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'SELECT * FROM payroll_released WHERE id = ?';


  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error fetching released payroll record:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }


    if (result.length === 0) {
      return res
        .status(404)
        .json({ error: 'Released payroll record not found' });
    }


    // Audit log: viewing single released payroll record
    logAudit(req.user, 'view', 'payroll_released', id);


    res.json(result[0]);
  });
});


// DELETE released payroll record (if needed for admin purposes)
router.delete('/released-payroll/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM payroll_released WHERE id = ?';


  db.query(query, [id], (err, result) => {
    if (err) {
      console.error('Error deleting released payroll record:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }


    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ error: 'Released payroll record not found' });
    }


    // Audit log: deleting released payroll record
    logAudit(req.user, 'delete', 'payroll_released', id);

    notifyPayrollChanged('deleted', { module: 'payroll-released', id });


    res.json({ message: 'Released payroll record deleted successfully' });
  });
});


// POST - Log payslip print (download)
router.post('/log-print', authenticateToken, (req, res) => {
  const { employeeNumber } = req.body;
  if (!employeeNumber) {
    return res.status(400).json({ error: 'Missing employeeNumber' });
  }
  try {
    logAudit(req.user, 'Print Payslip', 'payslip_print', null, employeeNumber);
    res.json({ success: true });
  } catch (e) {
    console.error('Audit log error:', e);
    res.status(500).json({ error: 'Failed to log audit' });
  }
});

// GET released payroll statistics
router.get('/released-payroll-stats', authenticateToken, requireAdmin, (req, res) => {
  const query = `
    SELECT
      COUNT(*) as totalReleased,
      COUNT(DISTINCT employeeNumber) as uniqueEmployees,
      COUNT(DISTINCT DATE(dateReleased)) as releaseDays,
      SUM(grossSalary) as totalGrossSalary,
      SUM(netSalary) as totalNetSalary,
      AVG(grossSalary) as avgGrossSalary,
      AVG(netSalary) as avgNetSalary
    FROM payroll_released
  `;


  db.query(query, (err, result) => {
    if (err) {
      console.error('Error fetching released payroll statistics:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }


    // Audit log: viewing released payroll statistics
    logAudit(req.user, 'view', 'payroll_released_stats', null);


    res.json(result[0]);
  });
});


module.exports = router;



