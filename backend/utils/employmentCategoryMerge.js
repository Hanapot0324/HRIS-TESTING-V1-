const db = require('../db');

/**
 * Set row.employmentCategory from employment_category (or -1 when none),
 * matching employee numbers the way the old
 *   LEFT JOIN employment_category ec ON CAST(x.employeeNumber AS CHAR) = CAST(ec.employeeNumber AS CHAR)
 * did (string compare, case- and trailing-space-insensitive; first row wins).
 * That join compared every payroll row with every category row and could run
 * for minutes on a year of payroll; this is one read of a small table.
 * On a lookup error the rows keep the value they already have.
 */
function attachEmploymentCategories(rows, done) {
  const list = Array.isArray(rows) ? rows : [];
  const keyOf = (v) => String(v ?? '').trimEnd().toLowerCase();
  db.query(
    'SELECT employeeNumber, employmentCategory FROM employment_category ORDER BY id',
    (err, cats) => {
      if (err) {
        console.error('Employment category merge:', err.message);
        return done(list);
      }
      const byEmp = new Map();
      for (const c of cats) {
        const k = keyOf(c.employeeNumber);
        if (!byEmp.has(k)) byEmp.set(k, c.employmentCategory);
      }
      // COALESCE(ec.employmentCategory, -1) took the column's type: "-1" for a
      // text column, -1 for a numeric one. Keep that so client checks still match.
      const sample = cats.find((c) => c.employmentCategory != null);
      const none = typeof sample?.employmentCategory === 'string' ? '-1' : -1;
      for (const row of list) {
        const cat = byEmp.get(keyOf(row.employeeNumber));
        row.employmentCategory = cat == null ? none : cat;
      }
      return done(list);
    },
  );
}

module.exports = { attachEmploymentCategories };
