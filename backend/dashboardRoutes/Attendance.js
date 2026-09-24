  const db = require('../db');
  const express = require('express');
  const router = express.Router();
  const jwt = require('jsonwebtoken');
  const { notifyAttendanceChanged } = require('../socket/socketService');
  const {
    getLatestAttendanceRecordInfo,
  } = require('../socket/attendanceRecordInfoSocketApi');
  const { logAudit, JWT_SECRET } = require('../middleware/auth');
  const { syncAggregatedDeviceDays } = require('../services/deviceAttendanceSyncService');

  function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid token' });
      }
      req.user = user;
      next();
    });
  }

  /**
   * Calendar YYYY-MM-DD for MySQL DATE / ISO strings without local-TZ drift.
   * mysql2 returns DATE as JS Date at UTC midnight of that calendar day.
   */
  function calendarYmd(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const y = value.getUTCFullYear();
      const m = String(value.getUTCMonth() + 1).padStart(2, '0');
      const d = String(value.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const s = String(value).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  /**
   * Device punches are unix-ms (UTC). HRIS calendar days are Asia/Manila (UTC+8).
   * Time IN is usually 06:00–07:59 Manila = still the previous UTC calendar day,
   * so UTC midnight bounds drop it from Device/DTR while Attendance State shows it.
   */
  function manilaDayRangeMs(startDate, endDate) {
    const sd = String(startDate || '').slice(0, 10);
    const ed = String(endDate || startDate || '').slice(0, 10);
    return {
      startTimestamp: Date.parse(`${sd}T00:00:00+08:00`),
      endTimestamp: Date.parse(`${ed}T23:59:59.999+08:00`),
    };
  }

  /** Manila YYYY-MM-DD from a millis column — session-TZ independent (epoch + 8h). */
  function manilaYmdSql(column = 'AttendanceDateTime') {
    return `DATE_FORMAT(DATE_ADD('1970-01-01 00:00:00', INTERVAL FLOOR(${column}/1000) + 28800 SECOND), '%Y-%m-%d')`;
  }

  function ymdInInclusiveRange(dateValue, startDate, endDate) {
    const d = calendarYmd(dateValue) || String(dateValue || '').slice(0, 10);
    const sd = String(startDate || '').slice(0, 10);
    const ed = String(endDate || startDate || '').slice(0, 10);
    return Boolean(d && sd && ed && d >= sd && d <= ed);
  }

  /** Inclusive UTC calendar-day walk — avoids toISOString/local getDate mismatches. */
  function forEachYmdInRange(startYmd, endYmd, fn) {
    if (!startYmd || !endYmd) return;
    const startT = Date.parse(`${startYmd}T00:00:00.000Z`);
    const endT = Date.parse(`${endYmd}T00:00:00.000Z`);
    if (Number.isNaN(startT) || Number.isNaN(endT) || startT > endT) return;
    for (let t = startT; t <= endT; t += 86400000) {
      const dt = new Date(t);
      fn(
        `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`,
      );
    }
  }

  /** Keep one object when alone; promote to array when multiple hit the same day. */
  function pushByDateEntry(byDate, key, entry) {
    if (!key || !entry) return;
    if (!byDate[key]) {
      byDate[key] = entry;
      return;
    }
    if (Array.isArray(byDate[key])) {
      byDate[key].push(entry);
      return;
    }
    byDate[key] = [byDate[key], entry];
  }

  /** One audit per explicit module button (search, DTR, device fetch, etc.). */
  function logAttendanceModuleButton(req, opts = {}) {
    const {
      module = 'Attendance Device',
      button,
      targetEmployeeNumber = null,
      targetName = null,
      periodStart = null,
      periodEnd = null,
      monthLabel = null,
      searchQuery = null,
      extra = null,
    } = opts;
    if (!button) return;

    const recordId =
      periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : null;

    const details = {
      button,
      actor_employeeNumber: req.user?.employeeNumber ?? null,
      target_employeeNumber: targetEmployeeNumber,
      target_name: targetName,
      period_start: periodStart,
      period_end: periodEnd,
      month_label: monthLabel,
      search_query: searchQuery || null,
      when: new Date().toISOString(),
      ...(extra && typeof extra === 'object' ? extra : {}),
    };

    logAudit(
      req.user,
      button,
      module,
      recordId,
      targetEmployeeNumber,
      details,
    );
  }

  const logAttendanceDeviceButton = (req, opts) =>
    logAttendanceModuleButton(req, { ...opts, module: opts.module || 'Attendance Device' });

  // ─── Helper: derive human-readable adjustment type from DB field name ─────────
  const fieldToAdjustmentType = (field = '') => {
    const f = field.toLowerCase();
    if (f === 'timein')        return 'Time In';
    if (f === 'timeout')       return 'Time Out';
    if (f === 'breaktimein')   return 'Breaktime In';
    if (f === 'breaktimeout')  return 'Breaktime Out';
    if (f === 'remarks')       return 'Remarks';
    if (f === 'autofill_remarks') return 'AutoFill Remarks';
    return 'Manual Entry';
  };

  // ─── Helper: write structured rows to attendance_adjustment_log ───────────────
  const writeAdjustmentLog = (db, req, { personID, date, dayOfWeek, operationType, remarks, autofillRemarks, changes }) => {
      if (!Array.isArray(changes) || changes.length === 0) return;

    const approvedBy =
      (req.user && (req.user.employeeNumber || req.user.username)) || null;

  const values = changes.map(({ field, before, after }) => [
      String(personID),
      String(date),
      dayOfWeek || null,
      field,
      fieldToAdjustmentType(field),
      before || null,
      after  || null,
      operationType || 'UPDATE',
      remarks        || null,
      autofillRemarks || null,
      approvedBy,
    ]);

  const sql = `
      INSERT INTO attendance_adjustment_log
        (personID, originalDate, dayOfWeek, fieldName, adjustmentType,
        valueBefore, valueAfter, operationType, remarks, autofill_remarks, approvedBy)
      VALUES ?
    `;

    db.query(sql, [values], (err) => {
      if (err) console.error('writeAdjustmentLog error:', err);
    });
  };

  // Helper function to format time
  const formatTime = (time) => {
    if (!time) return null;
    const str = String(time).trim();
    if (/am|pm/i.test(str)) {
      const parts = str.split(/[: ]/).filter(Boolean);
      const hour = parts[0] || '00';
      const minute = parts[1] || '00';
      const second = (parts[2] || '00').replace(/am|pm/i, '');
      const ampm = /pm/i.test(str) ? 'PM' : 'AM';
      return `${hour.padStart(2, '0')}:${minute}:${second} ${ampm}`;
    }
    const [hour, minute, second] = str.split(':');
    const hour24 = parseInt(hour, 10);
    const hour12 = hour24 % 12 || 12;
    const ampm = hour24 < 12 ? 'AM' : 'PM';
    return `${String(hour12).padStart(2, '0')}:${minute}:${second || '00'} ${ampm}`;
  };

  const convertDeviceMillisToManila = (timestamp) => {
    if (!timestamp) return null;
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const normalizeDateYmd = (d) => {
    if (!d) return '';
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    const s = String(d);
    return s.length >= 10 ? s.slice(0, 10) : s;
  };

  const ALLOWED_SPECIAL_TYPES = new Set(['HONORARIUM', 'SERVICE', 'OVERTIME']);

  const safeSpecialTypeForDb = (type) => {
    if (!type || type === 'UNCATEGORIZED') return null;
    return ALLOWED_SPECIAL_TYPES.has(type) ? type : null;
  };

  const DEVICE_RESTORE_REMARK =
    'Returned data from the device · Device data restored';

  const STATE_CORRECTION_REMARK_PREFIX = 'Updated in Attendance State';

  const attendanceStateLabel = (state) => {
    switch (Number(state)) {
      case 1: return 'Time IN';
      case 2: return 'Breaktime OUT';
      case 3: return 'Breaktime IN';
      case 4: return 'Time OUT';
      case 5: return 'Special Time IN';
      case 6: return 'Special Time OUT';
      default: return `State ${state}`;
    }
  };

  const buildStateCorrectionRemark = (previousState, newState) =>
    `${STATE_CORRECTION_REMARK_PREFIX} · punch status updated: ${attendanceStateLabel(previousState)} → ${attendanceStateLabel(newState)}`;

  /** SQL snippet: resolve display name for attendancerecord.modified_by */
  const MODIFIER_NAME_SELECT = `
    COALESCE(
      NULLIF(TRIM(CONCAT_WS(' ', modp.firstName, modp.middleName, modp.lastName)), ''),
      NULLIF(TRIM(CONCAT_WS(' ', modu_p.firstName, modu_p.middleName, modu_p.lastName)), ''),
      modu.username
    ) AS modified_by_name`;

  const MODIFIER_NAME_JOINS = `
    LEFT JOIN person_table modp
      ON CAST(ar.modified_by AS CHAR) = CAST(modp.agencyEmployeeNum AS CHAR)
    LEFT JOIN users modu
      ON CAST(ar.modified_by AS CHAR) = CAST(modu.employeeNumber AS CHAR)
      OR ar.modified_by = modu.username
    LEFT JOIN person_table modu_p
      ON modu.employeeNumber = modu_p.agencyEmployeeNum`;

  // Helper function to get day of week
  const getDayOfWeek = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  };

  // Helper function to parse time string to minutes for comparison
  const parseTimeToMinutes = (timeStr) => {
    if (!timeStr || typeof timeStr !== 'string') return null;

    const match = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const ampm = match[4]?.toUpperCase();

    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    return hours * 60 + minutes;
  };

  // Helper function to check if time falls within a range
  const timeIsInRange = (attendanceTime, startTime, endTime) => {
    const attMinutes = parseTimeToMinutes(attendanceTime);
    const startMinutes = parseTimeToMinutes(startTime);
    const endMinutes = parseTimeToMinutes(endTime);

    if (attMinutes === null || startMinutes === null || endMinutes === null) {
      return false;
    }

    if (endMinutes < startMinutes) {
      return attMinutes >= startMinutes || attMinutes <= endMinutes;
    }

    return attMinutes >= startMinutes && attMinutes <= endMinutes;
  };

  // Helper function to determine special type based on time and officialtime data
  const determineSpecialType = (attendanceTime, officialTimeData) => {
    if (!attendanceTime || !officialTimeData) {
      return { type: 'UNCATEGORIZED', isSpecial: true };
    }

    if (
      officialTimeData.officialHonorariumTimeIN &&
      officialTimeData.officialHonorariumTimeOUT &&
      timeIsInRange(
        attendanceTime,
        officialTimeData.officialHonorariumTimeIN,
        officialTimeData.officialHonorariumTimeOUT,
      )
    ) {
      return { type: 'HONORARIUM', isSpecial: true };
    }

    if (
      officialTimeData.officialServiceCreditTimeIN &&
      officialTimeData.officialServiceCreditTimeOUT &&
      timeIsInRange(
        attendanceTime,
        officialTimeData.officialServiceCreditTimeIN,
        officialTimeData.officialServiceCreditTimeOUT,
      )
    ) {
      return { type: 'SERVICE', isSpecial: true };
    }

    if (
      officialTimeData.officialOverTimeIN &&
      officialTimeData.officialOverTimeOUT &&
      timeIsInRange(
        attendanceTime,
        officialTimeData.officialOverTimeIN,
        officialTimeData.officialOverTimeOUT,
      )
    ) {
      return { type: 'OVERTIME', isSpecial: true };
    }

    return { type: 'UNCATEGORIZED', isSpecial: true };
  };

  // POST: one audit row per module search button (tardiness / month calculation)
  router.post('/api/module-search-audit', authenticateToken, (req, res) => {
    const {
      module,
      auditButton,
      targetEmployeeNumber,
      targetEmployeeName,
      periodStart,
      periodEnd,
      monthLabel,
      searchQuery,
      daysCalculated,
      totalLate,
      halfDayDate,
      halfDayStatus,
      computationModuleType,
      renderedTotal,
      tardinessTotal,
      halfDayNote,
      deductionSource,
      targetUsername,
      auditEvent,
      recordsCount,
      rowsChanged,
      changesSummary,
      saveRemarks,
      viewType,
    } = req.body || {};

    if (!module || !auditButton || !targetEmployeeNumber) {
      return res.status(400).json({
        error: 'module, auditButton, and targetEmployeeNumber are required',
      });
    }

    try {
      logAttendanceModuleButton(req, {
        module,
        button: auditButton,
        targetEmployeeNumber: String(targetEmployeeNumber),
        targetName: targetUsername || targetEmployeeName || null,
        periodStart: periodStart || null,
        periodEnd: periodEnd || null,
        monthLabel: monthLabel || null,
        searchQuery: searchQuery || null,
        extra: {
          days_calculated: daysCalculated ?? null,
          total_late: totalLate ?? null,
          half_day_date: halfDayDate || null,
          half_day_status: halfDayStatus || null,
          computation_module_type: computationModuleType || null,
          rendered_total: renderedTotal || null,
          tardiness_total: tardinessTotal || null,
          half_day_note: halfDayNote || null,
          deduction_source: deductionSource || null,
          target_username: targetUsername || targetEmployeeName || null,
          audit_event: auditEvent || null,
          records_count: recordsCount ?? null,
          rows_changed: rowsChanged ?? null,
          changes_summary: changesSummary || null,
          save_remarks: saveRemarks || null,
          view_type: viewType || null,
        },
      });
    } catch (e) {
      console.error('module-search-audit error:', e);
    }

    res.json({ ok: true });
  });

  // Endpoint to fetch attendance records
  router.get('/api/attendance', authenticateToken, (req, res) => {
    const { personId, startDate, endDate } = req.query;
    const sql = `
      SELECT DISTINCT attendancerecord.*, users.employeeNumber, users.username,
      users.employmentCategory, officialtime.*
      FROM attendancerecord
      JOIN users ON attendancerecord.personID = users.employeeNumber
      JOIN officialtime ON attendancerecord.Day = officialtime.day
        AND attendancerecord.personID = officialtime.employeeID
        AND attendancerecord.date BETWEEN officialtime.startDate AND officialtime.endDate
      WHERE attendancerecord.personID = ?
      AND attendancerecord.date BETWEEN ? AND ?
    `;
    db.query(sql, [personId, startDate, endDate], (err, results) => {
      if (err) {
        console.error('Error fetching data:', err);
        res.status(500).json({ error: 'Error fetching data' });
        return;
      }

      const leaveGapSql = `
        SELECT
          lr.id AS leave_request_id,
          lr.employeeNumber,
          DATE_FORMAT(lr.leave_date, '%Y-%m-%d') AS leave_day,
          DAYNAME(lr.leave_date) AS dow,
          u.username,
          u.employmentCategory,
          ot.id AS ot_row_id,
          ot.employeeID,
          ot.day AS ot_day,
          ot.startDate AS ot_startDate,
          ot.endDate AS ot_endDate,
          ot.officialTimeIN,
          ot.officialTimeOUT,
          ot.officialBreaktimeIN,
          ot.officialBreaktimeOUT,
          ot.officialHonorariumTimeIN,
          ot.officialHonorariumTimeOUT,
          ot.officialServiceCreditTimeIN,
          ot.officialServiceCreditTimeOUT,
          ot.officialOverTimeIN,
          ot.officialOverTimeOUT
        FROM leave_request lr
        INNER JOIN users u
          ON CAST(u.employeeNumber AS CHAR) = CAST(lr.employeeNumber AS CHAR)
        INNER JOIN officialtime ot
          ON CAST(ot.employeeID AS CHAR) = CAST(lr.employeeNumber AS CHAR)
          AND ot.day = DAYNAME(lr.leave_date)
          AND lr.leave_date BETWEEN ot.startDate AND ot.endDate
          AND ot.id = (
            SELECT MAX(ot2.id)
            FROM officialtime ot2
            WHERE CAST(ot2.employeeID AS CHAR) = CAST(lr.employeeNumber AS CHAR)
              AND ot2.day = DAYNAME(lr.leave_date)
              AND lr.leave_date BETWEEN ot2.startDate AND ot2.endDate
          )
        WHERE lr.status = 2
          AND CAST(lr.employeeNumber AS CHAR) = CAST(? AS CHAR)
          AND lr.leave_date BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM attendancerecord ar
            WHERE CAST(ar.personID AS CHAR) = CAST(lr.employeeNumber AS CHAR)
              AND ar.date = DATE_FORMAT(lr.leave_date, '%Y-%m-%d')
          )
      `;

      db.query(leaveGapSql, [personId, startDate, endDate], (err2, leaveRows) => {
        if (err2) {
          console.error('Error fetching leave-only attendance rows:', err2);
          return res.json(results || []);
        }

        const normDate = (d) => {
          if (!d) return '';
          const s = String(d);
          return s.length >= 10 ? s.slice(0, 10) : s;
        };
        const seenDates = new Set((results || []).map((r) => normDate(r.date)));
        const extras = [];

        for (const r of leaveRows || []) {
          const d = r.leave_day;
          if (!d || seenDates.has(d)) continue;
          seenDates.add(d);
          extras.push({
            id: null,
            personID: String(r.employeeNumber),
            date: d,
            Day: r.dow,
            day: r.dow,
            timeIN: r.officialTimeIN,
            breaktimeIN: r.officialBreaktimeIN,
            breaktimeOUT: r.officialBreaktimeOUT,
            timeOUT: r.officialTimeOUT,
            specialType: null,
            specialTimeIN: null,
            specialTimeOUT: null,
            employeeNumber: r.employeeNumber,
            username: r.username,
            employmentCategory: r.employmentCategory,
            officialTimeIN: r.officialTimeIN,
            officialTimeOUT: r.officialTimeOUT,
            officialBreaktimeIN: r.officialBreaktimeIN,
            officialBreaktimeOUT: r.officialBreaktimeOUT,
            officialHonorariumTimeIN: r.officialHonorariumTimeIN,
            officialHonorariumTimeOUT: r.officialHonorariumTimeOUT,
            officialServiceCreditTimeIN: r.officialServiceCreditTimeIN,
            officialServiceCreditTimeOUT: r.officialServiceCreditTimeOUT,
            officialOverTimeIN: r.officialOverTimeIN,
            officialOverTimeOUT: r.officialOverTimeOUT,
            _syntheticLeaveDay: true,
          });
        }

        const scheduleGapSql = `
          WITH RECURSIVE date_series AS (
            SELECT CAST(? AS DATE) AS cal_date
            UNION ALL
            SELECT DATE_ADD(cal_date, INTERVAL 1 DAY)
            FROM date_series
            WHERE cal_date < CAST(? AS DATE)
          )
          SELECT
            DATE_FORMAT(ds.cal_date, '%Y-%m-%d') AS gap_date,
            DAYNAME(ds.cal_date) AS dow,
            u.employeeNumber,
            u.username,
            u.employmentCategory,
            ot.officialTimeIN,
            ot.officialTimeOUT,
            ot.officialBreaktimeIN,
            ot.officialBreaktimeOUT,
            ot.officialHonorariumTimeIN,
            ot.officialHonorariumTimeOUT,
            ot.officialServiceCreditTimeIN,
            ot.officialServiceCreditTimeOUT,
            ot.officialOverTimeIN,
            ot.officialOverTimeOUT
          FROM date_series ds
          INNER JOIN officialtime ot
            ON CAST(ot.employeeID AS CHAR) = CAST(? AS CHAR)
            AND ot.day = DAYNAME(ds.cal_date)
            AND ds.cal_date BETWEEN ot.startDate AND ot.endDate
            AND ot.id = (
              SELECT MAX(ot2.id)
              FROM officialtime ot2
              WHERE CAST(ot2.employeeID AS CHAR) = CAST(? AS CHAR)
                AND ot2.day = DAYNAME(ds.cal_date)
                AND ds.cal_date BETWEEN ot2.startDate AND ot2.endDate
            )
          INNER JOIN users u
            ON CAST(u.employeeNumber AS CHAR) = CAST(? AS CHAR)
          WHERE ds.cal_date BETWEEN ? AND ?
            AND NOT EXISTS (
              SELECT 1 FROM attendancerecord ar
              WHERE CAST(ar.personID AS CHAR) = CAST(? AS CHAR)
                AND ar.date = DATE_FORMAT(ds.cal_date, '%Y-%m-%d')
            )
            AND NOT EXISTS (
              SELECT 1 FROM leave_request lr
              WHERE lr.status = 2
                AND CAST(lr.employeeNumber AS CHAR) = CAST(? AS CHAR)
                AND DATE_FORMAT(lr.leave_date, '%Y-%m-%d') = DATE_FORMAT(ds.cal_date, '%Y-%m-%d')
            )
        `;

        const scheduleGapParams = [
          startDate,
          endDate,
          personId,
          personId,
          personId,
          startDate,
          endDate,
          personId,
          personId,
        ];

        db.query(scheduleGapSql, scheduleGapParams, (err3, scheduleRows) => {
          if (err3) {
            console.error('Error fetching schedule-only attendance rows:', err3);
          } else {
            for (const r of scheduleRows || []) {
              const d = r.gap_date;
              if (!d || seenDates.has(d)) continue;
              seenDates.add(d);
              extras.push({
                id: null,
                personID: String(r.employeeNumber),
                date: d,
                Day: r.dow,
                day: r.dow,
                timeIN: null,
                breaktimeIN: null,
                breaktimeOUT: null,
                timeOUT: null,
                specialType: null,
                specialTimeIN: null,
                specialTimeOUT: null,
                employeeNumber: r.employeeNumber,
                username: r.username,
                employmentCategory: r.employmentCategory,
                officialTimeIN: r.officialTimeIN,
                officialTimeOUT: r.officialTimeOUT,
                officialBreaktimeIN: r.officialBreaktimeIN,
                officialBreaktimeOUT: r.officialBreaktimeOUT,
                officialHonorariumTimeIN: r.officialHonorariumTimeIN,
                officialHonorariumTimeOUT: r.officialHonorariumTimeOUT,
                officialServiceCreditTimeIN: r.officialServiceCreditTimeIN,
                officialServiceCreditTimeOUT: r.officialServiceCreditTimeOUT,
                officialOverTimeIN: r.officialOverTimeIN,
                officialOverTimeOUT: r.officialOverTimeOUT,
                _syntheticNoRecordDay: true,
              });
            }
          }

          const merged = [...(results || []), ...extras].sort((a, b) =>
            normDate(a.date).localeCompare(normDate(b.date)),
          );

          res.json(merged);
        });
      });
    });
  });

  // Endpoint to check if attendance record exists
  router.get('/api/check-attendance', authenticateToken, (req, res) => {
    const { personID, date } = req.query;
    const sql = `SELECT EXISTS(SELECT * FROM attendancerecord WHERE personID = ? AND date = ?) AS exists`;
    db.query(sql, [personID, date], (err, results) => {
      if (err) throw err;
      logAudit(req.user, 'search', 'attendance', date, personID);
      res.json(results[0]);
    });
  });

  // Endpoint to update attendance records
  router.post('/api/update-attendance', authenticateToken, (req, res) => {
    const { records } = req.body;

    const promises = records.map((record) => {
      const sql = `UPDATE attendancerecord SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ? WHERE id = ?`;
      return new Promise((resolve, reject) => {
        db.query(
          sql,
          [
            record.timeIN,
            record.breaktimeIN,
            record.breaktimeOUT,
            record.timeOUT,
            record.id,
          ],
          (err) => {
            if (err) return reject(err);
            logAudit(
              req.user,
              'update',
              'Attendance Module',
              record.id,
              record.personID,
            );
            resolve();
          },
        );
      });
    });

    Promise.all(promises)
      .then(() => {
        const personIDs = Array.isArray(records)
          ? [...new Set(records.map((r) => r.personID).filter(Boolean))]
          : [];
        const recordIds = Array.isArray(records)
          ? records.map((r) => r.id).filter(Boolean)
          : [];

        notifyAttendanceChanged('updated', {
          scope: 'attendancerecord',
          personIDs,
          recordIds,
        });

        res.json({ message: 'Records updated successfully' });
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  });

  // Additional endpoint for attendance with date filtering
  router.post('/api/attendance', authenticateToken, (req, res) => {
    const { personID, startDate, endDate } = req.body;

    const query = `
      SELECT PersonID, AttendanceDateTime, AttendanceState
      FROM AttendanceRecordInfo
      WHERE PersonID = ?
      AND AttendanceDateTime BETWEEN ? AND ?`;

    const startTimestamp = new Date(startDate).getTime();
    const endTimestamp = new Date(endDate).getTime();

    db.query(query, [personID, startTimestamp, endTimestamp], (err, results) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const records = results.map((record) => {
        const date = new Date(record.AttendanceDateTime);
        const options = {
          timeZone: 'Asia/Manila',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        };
        const manilaDate = date.toLocaleString('en-PH', options);

        return {
          PersonID: record.PersonID,
          Date: manilaDate.split(',')[0],
          Time: manilaDate.split(',')[1].trim(),
          AttendanceState: record.AttendanceState,
          AttendanceDateTime: record.AttendanceDateTime,
        };
      });

      res.json(records);
    });
  });

  // Raw device taps for several employees, so print can flag punches that will not mount.
  router.post('/api/attendance-raw-batch', authenticateToken, (req, res) => {
    const personIDs = [...new Set(
      (Array.isArray(req.body?.personIDs) ? req.body.personIDs : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean),
    )].slice(0, 50);
    const startDate = String(req.body?.startDate || '').slice(0, 10);
    const endDate = String(req.body?.endDate || '').slice(0, 10);

    if (!personIDs.length || !startDate || !endDate) {
      return res.status(400).json({ error: 'personIDs, startDate, and endDate are required' });
    }

    const { startTimestamp, endTimestamp } = manilaDayRangeMs(startDate, endDate);
    const placeholders = personIDs.map(() => '?').join(',');
    const query = `
      SELECT PersonID, AttendanceDateTime, AttendanceState
      FROM AttendanceRecordInfo
      WHERE TRIM(CAST(PersonID AS CHAR)) IN (${placeholders})
        AND AttendanceDateTime BETWEEN ? AND ?
    `;

    db.query(query, [...personIDs, startTimestamp, endTimestamp], (err, results) => {
      if (err) {
        console.error('attendance-raw-batch error:', err.message || err);
        return res.status(500).json({ error: err.message || 'Failed to fetch punch records' });
      }

      const records = (results || []).map((record) => {
        const date = new Date(record.AttendanceDateTime);
        const manilaDate = date.toLocaleString('en-PH', {
          timeZone: 'Asia/Manila',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        });
        return {
          PersonID: record.PersonID,
          Date: manilaDate.split(',')[0],
          Time: manilaDate.split(',')[1]?.trim() || '',
          AttendanceState: record.AttendanceState,
          AttendanceDateTime: record.AttendanceDateTime,
        };
      });

      res.json(records);
    });
  });

  // Send to DTR Module endpoint
  router.post('/api/send-to-dtr', authenticateToken, async (req, res) => {
    const { personID, startDate, endDate } = req.body;

    try {
      const checkQuery = `
        SELECT COUNT(*) as count
        FROM attendancerecord
        WHERE personID = ? AND date BETWEEN ? AND ?
      `;

      const recordCount = await new Promise((resolve, reject) => {
        db.query(checkQuery, [personID, startDate, endDate], (err, result) => {
          if (err) reject(err);
          else resolve(result[0].count);
        });
      });

      if (recordCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'No attendance records found for this period',
        });
      }

      if (req.body.auditButton) {
        logAttendanceDeviceButton(req, {
          button: req.body.auditButton,
          targetEmployeeNumber: personID,
          targetName: req.body.targetEmployeeName || null,
          periodStart: startDate,
          periodEnd: endDate,
          monthLabel: req.body.monthLabel || null,
        });
      }

      res.json({
        success: true,
        message: `Successfully prepared ${recordCount} records for DTR viewing`,
        recordCount,
      });
    } catch (error) {
      console.error('Error sending to DTR:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Bulk send to DTR for multiple users
  router.post('/api/bulk-send-to-dtr', authenticateToken, async (req, res) => {
    const { userIDs, startDate, endDate } = req.body;

    if (!Array.isArray(userIDs) || userIDs.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: 'No users selected' });
    }

    try {
      // Single grouped query instead of one COUNT per selected user (N+1 loop).
      const placeholders = userIDs.map(() => '?').join(',');
      const countSql = `
        SELECT personID, COUNT(*) AS count
        FROM attendancerecord
        WHERE personID IN (${placeholders}) AND date BETWEEN ? AND ?
        GROUP BY personID
      `;

      const countRows = await new Promise((resolve, reject) => {
        db.query(
          countSql,
          [...userIDs, startDate, endDate],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        );
      });

      const countMap = new Map(
        countRows.map((r) => [String(r.personID).trim(), Number(r.count) || 0]),
      );

      const results = userIDs.map((personID) => {
        const recordCount = countMap.get(String(personID).trim()) || 0;
        return {
          personID,
          recordCount,
          success: recordCount > 0,
        };
      });

      const successCount = results.filter((r) => r.success).length;
      const totalRecords = results.reduce((sum, r) => sum + r.recordCount, 0);

      if (req.body.auditButton) {
        logAttendanceDeviceButton(req, {
          button: req.body.auditButton,
          targetEmployeeNumber: null,
          targetName: `${successCount} of ${userIDs.length} selected`,
          periodStart: startDate,
          periodEnd: endDate,
          monthLabel: req.body.monthLabel || null,
          extra: { selected_user_ids: userIDs, success_count: successCount },
        });
      }

      res.json({
        success: true,
        message: `Successfully prepared DTR for ${successCount} users with ${totalRecords} total records`,
        results,
      });
    } catch (error) {
      console.error('Error bulk sending to DTR:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint to save attendance records
  // Batched: one SELECT to find existing rows, then one INSERT for the missing
  // ones (was 2 queries per record — an N+1 loop).
  router.post('/api/save-attendance', authenticateToken, (req, res) => {
    const { records } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.json([]);
    }

    const runQuery = (sql, params) =>
      new Promise((resolve, reject) => {
        db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });

    // 1) Find which (personID, date) pairs already exist — one query.
    const tuplePlaceholders = records.map(() => '(?, ?)').join(', ');
    const checkParams = records.flatMap((r) => [r.personID, r.date]);

    runQuery(
      `SELECT personID, date FROM attendancerecord WHERE (personID, date) IN (${tuplePlaceholders})`,
      checkParams,
    )
      .then((existingRows) => {
        const existingKeys = new Set(
          existingRows.map((r) => `${r.personID}|${r.date}`),
        );

        const results = records.map((record) => ({
          status: existingKeys.has(`${record.personID}|${record.date}`)
            ? 'exists'
            : 'pending',
          personID: record.personID,
          date: record.date,
        }));

        const toInsert = records.filter(
          (record, idx) => results[idx].status === 'pending',
        );

        if (toInsert.length === 0) {
          return { results, saved: [] };
        }

        // 2) Insert all missing rows in a single statement.
        const values = toInsert.map((record) => [
          record.personID,
          record.date,
          record.Day,
          record.timeIN,
          record.breaktimeIN,
          record.breaktimeOUT,
          record.timeOUT,
        ]);

        return runQuery(
          `INSERT INTO attendancerecord (personID, date, day, timeIN, breaktimeIN, breaktimeOUT, timeOUT) VALUES ?`,
          [values],
        ).then(() => {
          toInsert.forEach((record) => {
            results.find(
              (r) => r.personID === record.personID && r.date === record.date,
            ).status = 'saved';
            logAudit(
              req.user,
              'create',
              'Attendance Management',
              record.date,
              record.personID,
            );
          });
          return { results, saved: toInsert };
        });
      })
      .then((outcome) => {
        if (!outcome) return;

        const { results, saved } = outcome;

        if (saved.length > 0) {
          notifyAttendanceChanged('created', {
            scope: 'attendancerecord',
            personIDs: [...new Set(saved.map((r) => r.personID).filter(Boolean))],
            dates: [...new Set(saved.map((r) => r.date).filter(Boolean))],
          });
        }

        res.json(results);
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  });

  // Fetch records
  router.post('/api/view-attendance', authenticateToken, (req, res) => {
    const { personID, startDate, endDate } = req.body;

    const query = `
      SELECT
        ar.personID,
        ar.date,
        DAYNAME(ar.date) AS Day,
        ar.timeIN, ar.breaktimeIN, ar.breaktimeOUT, ar.timeOUT,
        ar.remarks, ar.autofill_remarks,
        ar.manually_modified, ar.modified_at, ar.modified_by,
        ${MODIFIER_NAME_SELECT},
        ar.specialType, ar.specialTimeIN, ar.specialTimeOUT,
        p.*,
        ot.officialTimeIN,
        ot.officialTimeOUT,
        ot.officialBreaktimeIN,
        ot.officialBreaktimeOUT,
        ot.officialHonorariumTimeIN,
        ot.officialHonorariumTimeOUT,
        ot.officialServiceCreditTimeIN,
        ot.officialServiceCreditTimeOUT,
        ot.officialOverTimeIN,
        ot.officialOverTimeOUT,
        CASE
          WHEN ari_daily.PersonID IS NULL THEN 1
          ELSE 0
        END AS manualEntry
      FROM attendancerecord ar
      INNER JOIN person_table p ON ar.personID = p.agencyEmployeeNum
      LEFT JOIN (
        SELECT
          PersonID,
          ${manilaYmdSql()} AS attDate
        FROM AttendanceRecordInfo
        WHERE PersonID = ?
          AND AttendanceDateTime BETWEEN ? AND ?
        GROUP BY PersonID, attDate
      ) ari_daily ON ari_daily.PersonID = ar.personID AND ari_daily.attDate = ar.date             
      ${MODIFIER_NAME_JOINS}
      LEFT JOIN officialtime ot ON DAYNAME(ar.date) = ot.day
        AND ar.personID = ot.employeeID
        AND ar.date BETWEEN ot.startDate AND ot.endDate
      WHERE ar.personID = ? AND ar.date BETWEEN ? AND ?
      ORDER BY ar.date ASC;
    `;

    const { startTimestamp: ariStartMs, endTimestamp: ariEndMs } = manilaDayRangeMs(startDate, endDate);
    db.query(query, [personID, ariStartMs, ariEndMs, personID, startDate, endDate], (err, results) => {
      if (err) {
        console.error('view-attendance error:', err.message || err);
        return res.status(500).json({ error: err.message || 'Failed to fetch attendance records' });
      }
      res.send(results);
    });
  });

  // ─── OPTIMIZED: Lightweight employee list for instant table render ────────────
  // Avoids full-table attendancerecordinfo GROUP BY (was the main list bottleneck).
  // Device names are fetched only for people missing person_table names.
  router.get('/api/dtr-employee-list', authenticateToken, (req, res) => {
    const { startDate, endDate, skipAudit } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const query = `
      SELECT DISTINCT
        ar.personID,
        p.firstName,
        p.lastName,
        p.middleName,
        u.branch,
        CASE
          WHEN p.agencyEmployeeNum IS NOT NULL THEN 'Registered'
          ELSE 'Not Registered'
        END AS registrationStatus
      FROM attendancerecord ar
      LEFT JOIN person_table p
        ON ar.personID = p.agencyEmployeeNum
      LEFT JOIN users u
        ON ar.personID = u.employeeNumber
      WHERE ar.date BETWEEN ? AND ?
      ORDER BY
        CASE WHEN p.lastName IS NULL THEN 1 ELSE 0 END,
        p.lastName  ASC,
        p.firstName ASC,
        ar.personID ASC
    `;

    db.query(query, [startDate, endDate], (err, results) => {
      if (err) return res.status(500).json({ error: err.message });

      const rows = results || [];
      const auditSkipped =
        skipAudit === '1' || skipAudit === 'true' || skipAudit === true;
      const finish = (payload) => {
        if (!auditSkipped) {
          logAudit(
            req.user,
            'Viewed DTR Employee List',
            'Daily Time Record Overall',
            `${startDate} to ${endDate}`,
            'all-users',
          );
        }
        res.json(payload);
      };

      const missingIds = [
        ...new Set(
          rows
            .filter((r) => !(r.firstName || r.lastName))
            .map((r) => String(r.personID ?? '').trim())
            .filter(Boolean),
        ),
      ];

      if (!missingIds.length) {
        return finish(rows.map((r) => ({ ...r, devicePersonName: null })));
      }

      const placeholders = missingIds.map(() => '?').join(',');
      db.query(
        `SELECT PersonID, MAX(PersonName) AS PersonName
         FROM attendancerecordinfo
         WHERE PersonID IN (${placeholders})
         GROUP BY PersonID`,
        missingIds,
        (nameErr, nameRows) => {
          if (nameErr) {
            console.warn('dtr-employee-list device names:', nameErr.message || nameErr);
            return finish(rows.map((r) => ({ ...r, devicePersonName: null })));
          }
          const nameMap = new Map();
          (nameRows || []).forEach((n) => {
            nameMap.set(String(n.PersonID), n.PersonName || null);
          });
          finish(
            rows.map((r) => ({
              ...r,
              devicePersonName: nameMap.get(String(r.personID)) || null,
            })),
          );
        },
      );
    });
  });

  // ─── OPTIMIZED: Paginated / by-employeeNumbers attendance ───────────────────
  // Prefer body.employeeNumbers (client already ranked the list) — skips CTE
  // re-rank, officialtime join, and attendancerecordinfo aggregation.
  router.post('/api/view-attendance-all-users-paged', authenticateToken, (req, res) => {
    const {
      startDate,
      endDate,
      page = 1,
      pageSize = 30,
      skipCount = false,
      skipAudit = false,
      employeeNumbers = null,
    } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    const ids = Array.isArray(employeeNumbers)
      ? [...new Set(employeeNumbers.map((n) => String(n).trim()).filter(Boolean))]
      : [];

    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const byIdsSql = `
        SELECT
          ar.personID,
          ar.date,
          DAYNAME(ar.date) AS Day,
          ar.timeIN, ar.breaktimeIN, ar.breaktimeOUT, ar.timeOUT,
          ar.specialType, ar.specialTimeIN, ar.specialTimeOUT,
          p.firstName, p.lastName, p.middleName,
          p.agencyEmployeeNum,
          CASE
            WHEN p.agencyEmployeeNum IS NOT NULL THEN 'Registered'
            ELSE 'Not Registered'
          END AS registrationStatus
        FROM attendancerecord ar
        LEFT JOIN person_table p ON ar.personID = p.agencyEmployeeNum
        WHERE ar.date BETWEEN ? AND ?
          AND ar.personID IN (${placeholders})
        ORDER BY ar.personID ASC, ar.date ASC
      `;

      return db.query(byIdsSql, [startDate, endDate, ...ids], (err, results) => {
        if (err) {
          console.error('Page query (employeeNumbers) error:', err);
          return res.status(500).json({ error: err.message });
        }
        if (!skipAudit) {
          logAudit(
            req.user,
            `Viewed DTR Records (by ids ${ids.length})`,
            'Daily Time Record Overall',
            `${startDate} to ${endDate}`,
            'all-users',
          );
        }
        res.json({
          data: results || [],
          total: ids.length,
          page: 1,
          pageSize: ids.length,
          totalPages: 1,
        });
      });
    }

    const offset = (page - 1) * pageSize;

    // Legacy offset path — no officialtime / device-name joins (loaded separately).
    const pageQuery = `
        WITH ranked_employees AS (
          SELECT DISTINCT
            ar.personID,
            p.lastName,
            p.firstName
          FROM attendancerecord ar
          LEFT JOIN person_table p ON ar.personID = p.agencyEmployeeNum
          WHERE ar.date BETWEEN ? AND ?
          ORDER BY
            CASE WHEN p.lastName IS NULL THEN 1 ELSE 0 END,
            p.lastName  ASC,
            p.firstName ASC,
            ar.personID ASC
          LIMIT ? OFFSET ?
        )
        SELECT
          ar.personID,
          ar.date,
          DAYNAME(ar.date)                AS Day,
          ar.timeIN, ar.breaktimeIN, ar.breaktimeOUT, ar.timeOUT,
          ar.specialType, ar.specialTimeIN, ar.specialTimeOUT,
          p.firstName, p.lastName, p.middleName,
          p.agencyEmployeeNum,
          CASE
            WHEN p.agencyEmployeeNum IS NOT NULL THEN 'Registered'
            ELSE 'Not Registered'
          END AS registrationStatus
        FROM ranked_employees re
        JOIN attendancerecord ar
          ON ar.personID = re.personID
        AND ar.date BETWEEN ? AND ?
        LEFT JOIN person_table p
          ON ar.personID = p.agencyEmployeeNum
        ORDER BY
          CASE WHEN p.lastName IS NULL THEN 1 ELSE 0 END,
          p.lastName  ASC,
          p.firstName ASC,
          ar.personID ASC,
          ar.date     ASC
      `;

    const runPageQuery = (total, totalPages) => {
      db.query(
        pageQuery,
        [startDate, endDate, pageSize, offset, startDate, endDate],
        (err, results) => {
          if (err) {
            console.error('Page query error:', err);
            return res.status(500).json({ error: err.message });
          }

          if (!skipAudit) {
            logAudit(
              req.user,
              `Viewed DTR Records (paged ${page}/${totalPages})`,
              'Daily Time Record Overall',
              `${startDate} to ${endDate}`,
              'all-users',
            );
          }

          res.json({ data: results, total, page, pageSize, totalPages });
        },
      );
    };

    if (skipCount) {
      return runPageQuery(null, null);
    }

    const countQuery = `
      SELECT COUNT(DISTINCT ar.personID) AS total
      FROM attendancerecord ar
      WHERE ar.date BETWEEN ? AND ?
    `;

    db.query(countQuery, [startDate, endDate], (countErr, countResult) => {
      if (countErr) {
        console.error('Count query error:', countErr);
        return res.status(500).json({ error: countErr.message });
      }

      const total = countResult[0]?.total ?? 0;
      const totalPages = Math.ceil(total / pageSize);

      if (total === 0) {
        return res.json({ data: [], total: 0, page, pageSize, totalPages: 0 });
      }

      runPageQuery(total, totalPages);
    });
  });

  // Get all attendance records for date range (original — kept for compatibility)
  router.post('/api/view-attendance-all-users', authenticateToken, (req, res) => {
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ error: 'Start date and end date are required' });
    }

    const query = `
      SELECT
        ar.personID,
        ar.date,
        DAYNAME(ar.date) AS Day,
        ar.timeIN, ar.breaktimeIN, ar.breaktimeOUT, ar.timeOUT,
        ar.specialType, ar.specialTimeIN, ar.specialTimeOUT,
        p.*,
        ot.officialTimeIN,
        ot.officialTimeOUT,
        ot.officialBreaktimeIN,
        ot.officialBreaktimeOUT,
        ot.officialHonorariumTimeIN,
        ot.officialHonorariumTimeOUT,
        ot.officialServiceCreditTimeIN,
        ot.officialServiceCreditTimeOUT,
        ot.officialOverTimeIN,
        ot.officialOverTimeOUT,
        CASE 
          WHEN p.agencyEmployeeNum IS NOT NULL THEN 'Registered'
          ELSE 'Not Registered'
        END AS registrationStatus,
        ari_names.PersonName as devicePersonName
      FROM attendancerecord ar
      LEFT JOIN person_table p ON ar.personID = p.agencyEmployeeNum
      LEFT JOIN officialtime ot ON DAYNAME(ar.date) = ot.day
        AND ar.personID = ot.employeeID
        AND ar.date BETWEEN ot.startDate AND ot.endDate
      LEFT JOIN (
        SELECT PersonID, MAX(PersonName) as PersonName
        FROM attendancerecordinfo
        GROUP BY PersonID
      ) ari_names ON ar.personID = ari_names.PersonID
      WHERE ar.date BETWEEN ? AND ?
      ORDER BY 
        CASE WHEN p.lastName IS NULL THEN 1 ELSE 0 END,
        p.lastName ASC, 
        p.firstName ASC, 
        ar.personID ASC,
        ar.date ASC;
    `;

    db.query(query, [startDate, endDate], (err, results) => {
      if (err) {
        console.error('Error fetching attendance records for all users:', err);
        return res.status(500).send(err);
      }

      logAudit(
        req.user,
        `Viewed DTR Records - All Users`,
        'Daily Time Record Overall',
        `${startDate} to ${endDate}`,
        'all-users',
      );

      res.send(results);
    });
  });

  // ─── UPDATE records (Records-Only tab) ───────────────────────────────────────
  // FIX: remarks (global save reason) is now ONLY written to rows that actually
  // had field-level changes. Unchanged rows keep their existing remarks intact.
  // changedRowKeys is an optional array of "personID-date" strings sent by the
  // frontend to identify which rows were dirty. If not provided we fall back to
  // detecting changes by comparing old vs new values (safe default).
  router.put('/api/view-attendance', authenticateToken, (req, res) => {
    const { records, remarks, changedRowKeys } = req.body;

    // Build a Set for O(1) lookup — frontend sends "personID-date" strings
    const changedSet = Array.isArray(changedRowKeys)
      ? new Set(changedRowKeys)
      : null;

    const updatePromises = records.map((record) => {
      const fetchQuery = `
        SELECT timeIN, breaktimeIN, breaktimeOUT, timeOUT, Day
        FROM attendancerecord
        WHERE personID = ? AND date = ?
      `;

      return new Promise((resolve, reject) => {
        db.query(fetchQuery, [record.personID, record.date], (fetchErr, existing) => {
          if (fetchErr) return reject(fetchErr);

          const old = existing[0] || {};
          const normalize = (val) => (val == null ? '' : String(val).trim());

          const FIELDS = [
            { key: 'timeIN',       label: 'Time IN'       },
            { key: 'breaktimeIN',  label: 'Breaktime IN'  },
            { key: 'breaktimeOUT', label: 'Breaktime OUT' },
            { key: 'timeOUT',      label: 'Time OUT'      },
          ];

          const changes = FIELDS
            .filter(({ key }) => normalize(old[key]) !== normalize(record[key]))
            .map(({ key, label }) => ({
              field:  key,
              label,
              before: normalize(old[key]),
              after:  normalize(record[key]),
            }));

          const hasChanged = changes.length > 0;

          // ── KEY FIX ──────────────────────────────────────────────────────────
          // Only apply the global save-remarks to rows that actually changed.
          // If the frontend supplied changedRowKeys, trust that set.
          // Otherwise fall back to comparing old vs new (hasChanged).
          const rowKey = `${record.personID}-${record.date}`;
          const rowWasChanged = changedSet ? changedSet.has(rowKey) : hasChanged;

          const remarksToWrite = rowWasChanged ? (remarks || null) : null;
          // ─────────────────────────────────────────────────────────────────────

          const diffStr = changes
            .map(({ label, before, after }) =>
              `${label}: [${before || 'empty'} → ${after || 'empty'}]`
            )
            .join(' | ');

          // autofill_remarks: use per-record value if provided, else preserve existing
          const autofillRemarks =
            record.autofill_remarks != null
              ? String(record.autofill_remarks).trim() || null
              : null;

          const modifiedBy =
            (req.user && (req.user.employeeNumber || req.user.username)) || null;

          const updateQuery = hasChanged
            ? `
            UPDATE attendancerecord
            SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ?,
                remarks = CASE WHEN ? IS NOT NULL THEN ? ELSE remarks END,
                autofill_remarks = COALESCE(?, autofill_remarks),
                manually_modified = 1,
                modified_at = NOW(),
                modified_by = ?
            WHERE personID = ? AND date = ?
          `
            : `
            UPDATE attendancerecord
            SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ?,
                remarks = CASE WHEN ? IS NOT NULL THEN ? ELSE remarks END,
                autofill_remarks = COALESCE(?, autofill_remarks)
            WHERE personID = ? AND date = ?
          `;

          // remarks written with a conditional: only overwrite when remarksToWrite is non-null
          const params = hasChanged
            ? [
                record.timeIN,
                record.breaktimeIN,
                record.breaktimeOUT,
                record.timeOUT,
                remarksToWrite,
                remarksToWrite,
                autofillRemarks,
                modifiedBy,
                record.personID,
                record.date,
              ]
            : [
                record.timeIN,
                record.breaktimeIN,
                record.breaktimeOUT,
                record.timeOUT,
                remarksToWrite,
                remarksToWrite,
                autofillRemarks,
                record.personID,
                record.date,
              ];

          db.query(updateQuery, params, (updateErr, result) => {
            if (updateErr) return reject(updateErr);

            if (hasChanged) {
              logAudit(
                req.user,
                `Updated Attendance Record | ${record.date} | ${diffStr}${remarksToWrite ? ` | Remarks: ${remarksToWrite}` : ''}${autofillRemarks ? ` | AutoFill: ${autofillRemarks}` : ''}`,
                'Attendance Modification',
                record.date,
                record.personID,
              );

  writeAdjustmentLog(db, req, {
                personID:        record.personID,
                date:            record.date,
                dayOfWeek:       old.Day || record.Day || null,
                operationType:   'UPDATE',
                remarks:         remarksToWrite,
                autofillRemarks: autofillRemarks,
                changes: changes.map(({ field, before, after }) => ({ field, before, after })),
              });
            }

            resolve(result);
          });
        });
      });
    });

    Promise.all(updatePromises)
      .then(() => {
        const personIDs = Array.isArray(records)
          ? [...new Set(records.map((r) => r.personID).filter(Boolean))]
          : [];
        if (personIDs.length > 0) {
          notifyAttendanceChanged('updated', {
            scope: 'attendancerecord',
            personIDs,
          });
        }
        res.send({ message: 'Records updated successfully.' });
      })
      .catch((err) => res.status(500).send(err));
  });

  // GET API for fetching attendance records
  router.get('/api/dtr', authenticateToken, (req, res) => {
    const { personID, startDate, endDate } = req.query;

    if (!personID || !startDate || !endDate) {
      return res
        .status(400)
        .json({ error: 'Missing required query parameters.' });
    }

    const query = `
      SELECT
        id, date, personID, time
      FROM
        attendancerecord
      WHERE
        personID = ? AND date BETWEEN ? AND ?
    `;

    db.query(query, [personID, startDate, endDate], (err, results) => {
      if (err) {
        console.error('Error executing query:', err);
        return res.status(500).json({ error: 'Database query failed.' });
      }
      logAudit(
        req.user,
        'view',
        'attendancerecord',
        `${startDate} && ${endDate}`,
        personID,
      );
      res.json(results);
    });
  });

  // ─── Daily late/undertime on overall_attendance_record (DTR source of truth) ───
  const normalizeYmd = (value) => {
    if (value == null || value === '') return '';
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s.split('T')[0] || '';
  };

  const parseDailyLateUndertimeJson = (raw) => {
    if (raw == null || raw === '') return {};
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(arr)) return {};
      const byDate = {};
      arr.forEach((r) => {
        const d = normalizeYmd(r.date);
        if (!d) return;
        byDate[d] = {
          lateTotal: r.lateTotal || '00:00:00',
          undertimeTotal: r.undertimeTotal || '00:00:00',
        };
      });
      return byDate;
    } catch {
      return {};
    }
  };

  const serializeDailyLateRows = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    return JSON.stringify(
      list.map((r) => {
        const row = {
          date: normalizeYmd(r.date),
          lateTotal: String(r.lateTotal || '00:00:00').trim(),
          undertimeTotal: String(r.undertimeTotal || '00:00:00').trim(),
        };
        const hash = String(r.inputHash || '').trim();
        if (hash) row.inputHash = hash;
        return row;
      }).filter((r) => r.date),
    );
  };

  const serializeHalfDayReview = (raw) => {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (!t) return null;
      try {
        JSON.parse(t);
        return t;
      } catch {
        return null;
      }
    }
    if (!Array.isArray(raw)) return null;
    return JSON.stringify(raw);
  };

  const findOverallByExactPeriod = (personID, startDate, endDate) =>
    new Promise((resolve, reject) => {
      db.query(
        `SELECT id FROM overall_attendance_record
        WHERE personID = ? AND startDate = ? AND endDate = ? LIMIT 1`,
        [String(personID), normalizeYmd(startDate), normalizeYmd(endDate)],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows?.[0]?.id ?? null);
        },
      );
    });

  // Upsert daily late/undertime when attendance module loads (no full save required)
  router.put(
    '/api/overall_attendance_record/daily-late-undertime',
    authenticateToken,
    async (req, res) => {
      const {
        personID,
        startDate,
        endDate,
        moduleType,
        rows,
        halfDayDates,
        half_day_review,
      } = req.body;

      if (!personID || !startDate || !endDate || !Array.isArray(rows)) {
        return res.status(400).json({
          error: 'personID, startDate, endDate, and rows array are required',
        });
      }

      const pid = String(personID).trim();
      const sd = normalizeYmd(startDate);
      const ed = normalizeYmd(endDate);
      const json = serializeDailyLateRows(rows);
      const halfDates =
        halfDayDates != null && String(halfDayDates).trim() !== ''
          ? String(halfDayDates).trim()
          : null;
      const modType = moduleType ? String(moduleType) : null;
      const reviewJson = serializeHalfDayReview(half_day_review);

      try {
        const existingId = await findOverallByExactPeriod(pid, sd, ed);
        if (existingId) {
          await new Promise((resolve, reject) => {
            db.query(
              `UPDATE overall_attendance_record SET
                daily_late_undertime = ?,
                computation_module_type = ?,
                halfDayDates = COALESCE(?, halfDayDates),
                half_day_review = COALESCE(?, half_day_review)
              WHERE id = ?`,
              [json, modType, halfDates, reviewJson, existingId],
              (err, result) => {
                if (err) reject(err);
                else resolve(result);
              },
            );
          });
          notifyAttendanceChanged('overall-daily-late-updated', {
            scope: 'overall_attendance_record',
            personID: pid,
            startDate: sd,
            endDate: ed,
          });
          return res.json({ ok: true, id: existingId, created: false });
        }

        const insertResult = await new Promise((resolve, reject) => {
          db.query(
            `INSERT INTO overall_attendance_record (
              personID, startDate, endDate,
              daily_late_undertime, computation_module_type, halfDayDates, half_day_review
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [pid, sd, ed, json, modType, halfDates, reviewJson],
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            },
          );
        });
        notifyAttendanceChanged('overall-daily-late-created', {
          scope: 'overall_attendance_record',
          personID: pid,
          startDate: sd,
          endDate: ed,
        });
        return res.json({
          ok: true,
          id: insertResult.insertId,
          created: true,
        });
      } catch (err) {
        console.error('daily-late-undertime upsert error:', err);
        return res.status(500).json({ error: err.message });
      }
    },
  );

  const DAILY_LATE_BATCH_CHUNK = 150;

  router.post(
    '/api/overall_attendance_record/daily-late-undertime/batch',
    authenticateToken,
    (req, res) => {
      const { startDate, endDate, employeeNumbers } = req.body;
      const sd = normalizeYmd(startDate);
      const ed = normalizeYmd(endDate);
      if (!sd || !ed) {
        return res.status(400).json({ error: 'startDate and endDate are required' });
      }

      const ids = Array.isArray(employeeNumbers)
        ? [...new Set(employeeNumbers.map((n) => String(n).trim()).filter(Boolean))]
        : [];

      if (ids.length === 0) {
        return res.json({ periodStart: sd, periodEnd: ed, byEmployee: {}, halfDayDatesByEmployee: {} });
      }

      const byEmployee = {};
      const halfDayDatesByEmployee = {};
      const metaByEmployee = {};
      ids.forEach((id) => {
        byEmployee[id] = {};
      });

      const chunks = [];
      for (let i = 0; i < ids.length; i += DAILY_LATE_BATCH_CHUNK) {
        chunks.push(ids.slice(i, i + DAILY_LATE_BATCH_CHUNK));
      }

      const runChunk = (chunk) =>
        new Promise((resolve, reject) => {
          const placeholders = chunk.map(() => '?').join(',');
          db.query(
            `SELECT personID, daily_late_undertime, halfDayDates, half_day_review, computation_module_type
            FROM overall_attendance_record
            WHERE startDate = ? AND endDate = ?
              AND personID IN (${placeholders})`,
            [sd, ed, ...chunk],
            (err, rows) => {
              if (err) return reject(err);
              (rows || []).forEach((r) => {
                const emp = String(r.personID).trim();
                if (!emp) return;
                Object.assign(byEmployee[emp], parseDailyLateUndertimeJson(r.daily_late_undertime));
                if (r.halfDayDates) {
                  halfDayDatesByEmployee[emp] = String(r.halfDayDates);
                }
                metaByEmployee[emp] = {
                  half_day_review: r.half_day_review,
                  computation_module_type: r.computation_module_type,
                };
              });
              resolve();
            },
          );
        });

      Promise.all(chunks.map(runChunk))
        .then(() =>
          res.json({
            periodStart: sd,
            periodEnd: ed,
            byEmployee,
            halfDayDatesByEmployee,
            metaByEmployee,
          }),
        )
        .catch((err) => {
          console.error('daily-late-undertime batch error:', err);
          res.status(500).json({ error: err.message });
        });
    },
  );

  // Insert overall attendance record (upsert by exact person+period)
  router.post('/api/overall_attendance', authenticateToken, async (req, res) => {
    const {
      personID,
      startDate,
      endDate,
      totalRenderedTimeMorning,
      totalRenderedTimeMorningTardiness,
      totalRenderedTimeAfternoon,
      totalRenderedTimeAfternoonTardiness,
      totalRenderedHonorarium,
      totalRenderedHonorariumTardiness,
      totalRenderedServiceCredit,
      totalRenderedServiceCreditTardiness,
      totalRenderedOvertime,
      totalRenderedOvertimeTardiness,
      overallRenderedOfficialTime,
      overallRenderedOfficialTimeTardiness,
      overallTotalOfficialSchedule,
      absentDays,
      halfDays,
      absentTime,
      halfDayShortfallTime,
      lateTotalTime,
      absentDates,
      halfDayDates,
      daily_late_undertime,
      computation_module_type,
      half_day_review,
    } = req.body;

    const dailyJson =
      daily_late_undertime != null
        ? typeof daily_late_undertime === 'string'
          ? daily_late_undertime
          : serializeDailyLateRows(daily_late_undertime)
        : null;
    const reviewJson = serializeHalfDayReview(half_day_review);

    try {
      const pid = String(personID ?? '').trim();
      const sd = normalizeYmd(startDate);
      const ed = normalizeYmd(endDate);
      if (!pid || !sd || !ed) {
        return res.status(400).json({ message: 'personID, startDate, and endDate are required' });
      }

      const existingId = await findOverallByExactPeriod(pid, sd, ed);
      if (existingId) {
        await new Promise((resolve, reject) => {
          db.query(
            `UPDATE overall_attendance_record SET
              totalRenderedTimeMorning = ?,
              totalRenderedTimeMorningTardiness = ?,
              totalRenderedTimeAfternoon = ?,
              totalRenderedTimeAfternoonTardiness = ?,
              totalRenderedHonorarium = ?,
              totalRenderedHonorariumTardiness = ?,
              totalRenderedServiceCredit = ?,
              totalRenderedServiceCreditTardiness = ?,
              totalRenderedOvertime = ?,
              totalRenderedOvertimeTardiness = ?,
              overallRenderedOfficialTime = ?,
              overallRenderedOfficialTimeTardiness = ?,
              overallTotalOfficialSchedule = ?,
              absentDays = ?,
              halfDays = ?,
              absentTime = ?,
              halfDayShortfallTime = ?,
              lateTotalTime = ?,
              absentDates = ?,
              halfDayDates = ?,
              daily_late_undertime = ?,
              computation_module_type = ?,
              half_day_review = ?
            WHERE id = ?`,
            [
              totalRenderedTimeMorning ?? null,
              totalRenderedTimeMorningTardiness ?? null,
              totalRenderedTimeAfternoon ?? null,
              totalRenderedTimeAfternoonTardiness ?? null,
              totalRenderedHonorarium ?? null,
              totalRenderedHonorariumTardiness ?? null,
              totalRenderedServiceCredit ?? null,
              totalRenderedServiceCreditTardiness ?? null,
              totalRenderedOvertime ?? null,
              totalRenderedOvertimeTardiness ?? null,
              overallRenderedOfficialTime ?? null,
              overallRenderedOfficialTimeTardiness ?? null,
              overallTotalOfficialSchedule ?? null,
              absentDays ?? null,
              halfDays ?? null,
              absentTime ?? null,
              halfDayShortfallTime ?? null,
              lateTotalTime ?? null,
              absentDates ?? null,
              halfDayDates ?? null,
              dailyJson,
              computation_module_type ?? null,
              reviewJson,
              existingId,
            ],
            (error, results) => {
              if (error) reject(error);
              else resolve(results);
            },
          );
        });

        logAudit(
          req.user,
          `Saved Overall Attendance Record`,
          'Attendance Module (Non-Teaching/30hrs/40hrs)',
          `${sd} to ${ed}`,
          pid,
        );
        notifyAttendanceChanged('overall-updated', {
          scope: 'overall_attendance_record',
          personID: pid,
          startDate: sd,
          endDate: ed,
        });
        return res.status(200).json({
          message: 'Attendance record updated successfully',
          id: existingId,
          updated: true,
        });
      }

      const insertResult = await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO overall_attendance_record (
            personID, startDate, endDate,
            totalRenderedTimeMorning, totalRenderedTimeMorningTardiness,
            totalRenderedTimeAfternoon, totalRenderedTimeAfternoonTardiness,
            totalRenderedHonorarium, totalRenderedHonorariumTardiness,
            totalRenderedServiceCredit, totalRenderedServiceCreditTardiness,
            totalRenderedOvertime, totalRenderedOvertimeTardiness,
            overallRenderedOfficialTime, overallRenderedOfficialTimeTardiness,
            overallTotalOfficialSchedule,
            absentDays, halfDays,
            absentTime, halfDayShortfallTime,
            lateTotalTime,
            absentDates, halfDayDates,
            daily_late_undertime, computation_module_type, half_day_review
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            pid,
            sd,
            ed,
            totalRenderedTimeMorning ?? null,
            totalRenderedTimeMorningTardiness ?? null,
            totalRenderedTimeAfternoon ?? null,
            totalRenderedTimeAfternoonTardiness ?? null,
            totalRenderedHonorarium ?? null,
            totalRenderedHonorariumTardiness ?? null,
            totalRenderedServiceCredit ?? null,
            totalRenderedServiceCreditTardiness ?? null,
            totalRenderedOvertime ?? null,
            totalRenderedOvertimeTardiness ?? null,
            overallRenderedOfficialTime ?? null,
            overallRenderedOfficialTimeTardiness ?? null,
            overallTotalOfficialSchedule ?? null,
            absentDays ?? null,
            halfDays ?? null,
            absentTime ?? null,
            halfDayShortfallTime ?? null,
            lateTotalTime ?? null,
            absentDates ?? null,
            halfDayDates ?? null,
            dailyJson,
            computation_module_type ?? null,
            reviewJson,
          ],
          (error, results) => {
            if (error) reject(error);
            else resolve(results);
          },
        );
      });

      logAudit(
        req.user,
        `Saved Overall Attendance Record`,
        'Attendance Module (Non-Teaching/30hrs/40hrs)',
        `${sd} to ${ed}`,
        pid,
      );
      notifyAttendanceChanged('overall-created', {
        scope: 'overall_attendance_record',
        personID: pid,
        startDate: sd,
        endDate: ed,
      });
      return res.status(201).json({
        message: 'Attendance record saved successfully',
        id: insertResult.insertId,
        created: true,
      });
    } catch (error) {
      console.error('Error saving overall attendance record:', error);
      return res.status(500).json({ message: 'Database error', error });
    }
  });

  // Fetch overall attendance record
  router.get('/api/overall_attendance_record', authenticateToken, (req, res) => {
    const { personID, startDate, endDate } = req.query;

    const query = `
      SELECT
        overall_attendance_record.*,
        department_assignment.code
      FROM
        overall_attendance_record
      LEFT JOIN
        department_assignment
      ON
        department_assignment.employeeNumber = overall_attendance_record.personID
      WHERE
        overall_attendance_record.personID = ?
        AND overall_attendance_record.startDate <= ?
        AND overall_attendance_record.endDate >= ?
    `;

    db.query(query, [personID, endDate, startDate], (error, results) => {
      if (error) {
        console.error('Error Fetching data:', error);
        return res.status(500).json({ message: 'Database error', error });
      }
      res.status(200).json({
        message: 'Overall attendance record fetched successfully',
        data: results,
      });
    });
  });

  // List absent dates across employees (for Absences Report)
  router.get('/api/overall_attendance_absences', authenticateToken, (req, res) => {
    const { from, to, limitDays } = req.query;

    const windowDays = Number(limitDays) > 0 ? Math.min(Number(limitDays), 366) : 120;

    const query = `
      SELECT
        oar.personID,
        oar.startDate,
        oar.endDate,
        oar.absentDates,
        da.code AS department
      FROM overall_attendance_record oar
      LEFT JOIN department_assignment da
        ON da.employeeNumber = oar.personID
      WHERE oar.absentDates IS NOT NULL
        AND TRIM(oar.absentDates) <> ''
        AND (
          (? IS NOT NULL AND ? IS NOT NULL AND oar.startDate <= ? AND oar.endDate >= ?)
          OR
          (? IS NULL OR ? IS NULL)
        )
      ORDER BY oar.endDate DESC
    `;

    const toMysqlDateOnly = (d) => {
      if (!d) return null;
      const s = String(d).trim();
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };
    const fromDateOnly = toMysqlDateOnly(from);
    const toDateOnly = toMysqlDateOnly(to);

    db.query(
      query,
      [
        fromDateOnly,
        toDateOnly,
        toDateOnly,
        fromDateOnly,
        fromDateOnly,
        toDateOnly,
      ],
      (error, results) => {
        if (error) {
          console.error('Error Fetching overall attendance absences:', error);
          return res.status(500).json({ message: 'Database error', error });
        }

        const today = new Date();
        const cutoff = new Date(today);
        cutoff.setDate(today.getDate() - windowDays);

        const inWindow = (dateStr) => {
          const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!m) return false;
          const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          if (Number.isNaN(dt.getTime())) return false;
          if (fromDateOnly && dt < new Date(fromDateOnly)) return false;
          if (toDateOnly && dt > new Date(toDateOnly)) return false;
          if (!fromDateOnly && !toDateOnly && dt < cutoff) return false;
          return true;
        };

        const absences = [];
        for (const row of Array.isArray(results) ? results : []) {
          const personID = row.personID;
          const dept = row.department || row.code || '—';
          const raw = String(row.absentDates || '');
          const dateMatches = raw.match(/\d{4}-\d{2}-\d{2}/g) || [];
          for (const d of dateMatches) {
            if (!inWindow(d)) continue;
            absences.push({
              employeeNumber: String(personID || ''),
              department: dept,
              date: d,
              source: 'overall_attendance_record',
            });
          }
        }

        const seen = new Set();
        const unique = [];
        for (const a of absences) {
          const k = `${a.employeeNumber}|${a.date}`;
          if (seen.has(k)) continue;
          seen.add(k);
          unique.push(a);
        }

        res.status(200).json({
          message: 'Overall attendance absences fetched successfully',
          data: unique,
        });
      },
    );
  });

  // Update overall attendance record
  router.put(
    '/api/overall_attendance_record/:id',
    authenticateToken,
    (req, res) => {
      const {
        personID, startDate, endDate,
        totalRenderedTimeMorning, totalRenderedTimeMorningTardiness,
        totalRenderedTimeAfternoon, totalRenderedTimeAfternoonTardiness,
        totalRenderedHonorarium, totalRenderedHonorariumTardiness,
        totalRenderedServiceCredit, totalRenderedServiceCreditTardiness,
        totalRenderedOvertime, totalRenderedOvertimeTardiness,
        overallRenderedOfficialTime, overallRenderedOfficialTimeTardiness,
        overallTotalOfficialSchedule,
        absentDays,
        halfDays,
        absentTime,
        halfDayShortfallTime,
        lateTotalTime,
        absentDates,
        halfDayDates,
        daily_late_undertime,
        computation_module_type,
        half_day_review,
      } = req.body;

      const { id } = req.params;

      const dailyJson =
        daily_late_undertime != null
          ? typeof daily_late_undertime === 'string'
            ? daily_late_undertime
            : serializeDailyLateRows(daily_late_undertime)
          : null;
      const reviewJson = serializeHalfDayReview(half_day_review);

      const checkQuery = `SELECT * FROM overall_attendance_record WHERE personID = ? AND startDate = ? AND endDate = ? AND id != ?`;

      db.query(
        checkQuery,
        [personID, startDate, endDate, id],
        (checkError, checkResults) => {
          if (checkError) {
            return res.status(500).json({
              message: 'Database error while checking for duplicates',
              error: checkError,
            });
          }

          if (checkResults.length > 0) {
            return res.status(400).json({
              message: 'Duplicate record found with the same personID, startDate, and endDate',
            });
          }

          const query = `
        UPDATE overall_attendance_record SET
        personID = ?, startDate = ?, endDate = ?,
        totalRenderedTimeMorning = ?, totalRenderedTimeMorningTardiness = ?,
        totalRenderedTimeAfternoon = ?, totalRenderedTimeAfternoonTardiness = ?,
        totalRenderedHonorarium = ?, totalRenderedHonorariumTardiness = ?,
        totalRenderedServiceCredit = ?, totalRenderedServiceCreditTardiness = ?,
        totalRenderedOvertime = ?, totalRenderedOvertimeTardiness = ?,
        overallRenderedOfficialTime = ?, overallRenderedOfficialTimeTardiness = ?,
        overallTotalOfficialSchedule = ?,
        absentDays = ?, halfDays = ?,
        absentTime = ?, halfDayShortfallTime = ?,
        lateTotalTime = ?,
        absentDates = ?, halfDayDates = ?,
        daily_late_undertime = COALESCE(?, daily_late_undertime),
        computation_module_type = COALESCE(?, computation_module_type),
        half_day_review = COALESCE(?, half_day_review)
        WHERE id = ?
      `;

          db.query(
            query,
            [
              personID, startDate, endDate,
              totalRenderedTimeMorning, totalRenderedTimeMorningTardiness,
              totalRenderedTimeAfternoon, totalRenderedTimeAfternoonTardiness,
              totalRenderedHonorarium, totalRenderedHonorariumTardiness,
              totalRenderedServiceCredit, totalRenderedServiceCreditTardiness,
              totalRenderedOvertime, totalRenderedOvertimeTardiness,
              overallRenderedOfficialTime, overallRenderedOfficialTimeTardiness,
              overallTotalOfficialSchedule,
              absentDays ?? null,
              halfDays ?? null,
              absentTime ?? null,
              halfDayShortfallTime ?? null,
              lateTotalTime ?? null,
              absentDates ?? null,
              halfDayDates ?? null,
              dailyJson,
              computation_module_type ?? null,
              reviewJson,
              id,
            ],
            (error, results) => {
              if (error) {
                console.error(error);
                return res.status(500).json({ message: 'Database error', error });
              }
              logAudit(
                req.user,
                `Updated Overall Attendance Record`,
                'AttendanceSummary',
                `${startDate} to ${endDate}`,
                personID,
              );
              notifyAttendanceChanged('overall-updated', {
                scope: 'overall_attendance_record',
                id, personID, startDate, endDate,
              });
              res.status(200).json({ message: 'Record updated successfully', data: results });
            },
          );
        },
      );
    },
  );

  // Delete overall attendance record
  router.delete(
    '/api/overall_attendance_record/:id/:personID',
    authenticateToken,
    (req, res) => {
      const { id, personID } = req.params;

      const query = `DELETE FROM overall_attendance_record WHERE id = ? AND personID = ?`;

      db.query(query, [id, personID], (err, result) => {
        if (err) {
          console.error('Error deleting attendance entry:', err);
          return res.status(500).send({ message: 'Internal Server Error' });
        }

        if (result.affectedRows === 0) {
          return res.status(404).send({
            message: 'Attendance record not found or personID mismatch',
          });
        }
        logAudit(
          req.user,
          `Deleted Overall Attendance Record`,
          'AttendanceSummary',
          id,
          personID,
        );
        notifyAttendanceChanged('overall-deleted', {
          scope: 'overall_attendance_record',
          id, personID,
        });
        res.status(200).send({ message: 'Attendance entry deleted' });
      });
    },
  );

  // fetch audit logs
  router.get('/api/audit-log', (req, res) => {
    const sql = `SELECT * FROM audit_log ORDER BY timestamp DESC`;
    db.query(sql, (err, results) => {
      if (err)
        return res.status(500).json({ error: 'Error fetching audit logs' });
      res.json(results);
    });
  });

  // GET TIME IN TIME OUT FOR PERIOD
  router.post('/api/attendance-records', authenticateToken, (req, res) => {
    const { personID, startDate, endDate } = req.body;

    if (!personID || !startDate || !endDate) {
      return res
        .status(400)
        .json({ error: 'personID, startDate, and endDate are required' });
    }

    const sql = `
      SELECT
        id, personID, date, Day,
        timeIN, breaktimeIN, breaktimeOUT, timeOUT
      FROM attendancerecord
      WHERE personID = ?
        AND date >= ?
        AND date <= ?
      ORDER BY date ASC
    `;

    db.query(sql, [personID, startDate, endDate], (err, result) => {
      if (err) {
        console.error('Error fetching attendance records:', err);
        return res
          .status(500)
          .json({ message: 'Error fetching attendance records' });
      }
      res.json(result);
    });
  });

  // GET /attendance/monthly - Monthly attendance statistics
  router.get('/attendance/monthly', authenticateToken, (req, res) => {
    const { month } = req.query;

    let startDate = '2025-09-01';
    let endDate = '2025-09-30';

    if (month) {
      const [year, monthNum] = month.split('-');
      const lastDay = new Date(year, monthNum, 0).getDate();
      startDate = `${year}-${monthNum}-01`;
      endDate = `${year}-${monthNum}-${lastDay}`;
    }

    const sql = `
      SELECT DATE(Date) as day, COUNT(DISTINCT PersonID) as present
      FROM AttendanceRecordInfo
      WHERE AttendanceState = 1
        AND Date BETWEEN ? AND ?
      GROUP BY DATE(Date)
      ORDER BY day ASC
    `;

    db.query(sql, [startDate, endDate], (err, results) => {
      if (err) {
        console.error('Error fetching monthly attendance:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(results);
    });
  });

  // Get unique PersonIDs from AttendanceRecordInfo (optionally scoped to a date range)
  router.get('/api/attendance-record-info/latest', authenticateToken, async (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 100;

    try {
      const records = await getLatestAttendanceRecordInfo(limit);
      res.json({
        records,
        count: records.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Error fetching latest AttendanceRecordInfo rows:', err);
      res.status(500).json({ error: err.message || 'Database error' });
    }
  });

  // Get unique PersonIDs from AttendanceRecordInfo (optionally scoped to a date range)
  // Cached briefly — Facial Compare and Device Insights hit this on large tables.
  const allDeviceUsersCache = new Map();
  const ALL_DEVICE_USERS_TTL_MS = 90_000;

  router.get('/api/all-device-users', authenticateToken, (req, res) => {
    const { startDate, endDate, mode } = req.query || {};
    const hasRange = Boolean(startDate && endDate);
    const lean = String(mode || '') === 'compare';
    let startTimestamp;
    let endTimestamp;
    if (hasRange) {
      const range = manilaDayRangeMs(startDate, endDate);
      startTimestamp = range.startTimestamp;
      endTimestamp = range.endTimestamp;
    }

    const cacheKey = hasRange
      ? `range:${startTimestamp}:${endTimestamp}:${lean ? 'lean' : 'full'}`
      : `all:${lean ? 'lean' : 'full'}`;
    const cached = allDeviceUsersCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.set('X-Device-Users-Cache', 'HIT');
      return res.json(cached.data);
    }
    if (cached?.inflight) {
      return cached.inflight
        .then((data) => {
          res.set('X-Device-Users-Cache', 'WAIT');
          res.json(data);
        })
        .catch((err) => {
          res.status(500).json({ error: err.message });
        });
    }

    // Lean compare mode skips firstSeen + ORDER BY (sort client-side if needed).
    const query = hasRange
      ? lean
        ? `
      SELECT
        PersonID,
        MAX(PersonName) AS PersonName,
        MAX(AttendanceDateTime) AS lastSeen
      FROM AttendanceRecordInfo
      WHERE AttendanceDateTime BETWEEN ? AND ?
      GROUP BY PersonID
    `
        : `
      SELECT
        PersonID,
        MAX(PersonName) AS PersonName,
        MIN(AttendanceDateTime) AS firstSeen,
        MAX(AttendanceDateTime) AS lastSeen
      FROM AttendanceRecordInfo
      WHERE AttendanceDateTime BETWEEN ? AND ?
      GROUP BY PersonID
      ORDER BY PersonName ASC
    `
      : lean
        ? `
      SELECT
        PersonID,
        MAX(PersonName) AS PersonName,
        MAX(AttendanceDateTime) AS lastSeen
      FROM AttendanceRecordInfo
      GROUP BY PersonID
    `
        : `
      SELECT
        PersonID,
        MAX(PersonName) AS PersonName,
        MIN(AttendanceDateTime) AS firstSeen,
        MAX(AttendanceDateTime) AS lastSeen
      FROM AttendanceRecordInfo
      GROUP BY PersonID
      ORDER BY PersonName ASC
    `;

    const params = hasRange ? [startTimestamp, endTimestamp] : [];
    const inflight = new Promise((resolve, reject) => {
      db.query(query, params, (err, results) => {
        if (err) reject(err);
        else resolve(results || []);
      });
    });

    allDeviceUsersCache.set(cacheKey, {
      data: null,
      expiresAt: 0,
      inflight,
    });

    inflight
      .then((results) => {
        allDeviceUsersCache.set(cacheKey, {
          data: results,
          expiresAt: Date.now() + ALL_DEVICE_USERS_TTL_MS,
          inflight: null,
        });
        res.set('X-Device-Users-Cache', 'MISS');
        res.json(results);
      })
      .catch((err) => {
        allDeviceUsersCache.delete(cacheKey);
        console.error('Error fetching device users:', err);
        res.status(500).json({ error: err.message });
      });
  });

  // One round-trip for Device Insights section (date-scoped)
  router.post('/api/device-insights-bundle', authenticateToken, (req, res) => {
    const { startDate, endDate } = req.body || {};
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const sd = String(startDate).slice(0, 10);
    const ed = String(endDate).slice(0, 10);
    const { startTimestamp, endTimestamp } = manilaDayRangeMs(sd, ed);

    const usersSql = `
      SELECT
        PersonID,
        MAX(PersonName) AS PersonName,
        MIN(AttendanceDateTime) AS firstSeen,
        MAX(AttendanceDateTime) AS lastSeen
      FROM AttendanceRecordInfo
      WHERE AttendanceDateTime BETWEEN ? AND ?
      GROUP BY PersonID
      ORDER BY PersonName ASC
    `;

    const summarySql = `
      SELECT
        daily.PersonID,
        COUNT(*) AS recordsCount,
        IFNULL(raw.rawRecordCount, 0) AS rawRecordCount
      FROM (
        SELECT
          PersonID,
          ${manilaYmdSql()} AS dt
        FROM AttendanceRecordInfo
        WHERE AttendanceDateTime BETWEEN ? AND ?
        GROUP BY PersonID, dt
      ) daily
      LEFT JOIN (
        SELECT PersonID, COUNT(*) AS rawRecordCount
        FROM AttendanceRecordInfo
        WHERE AttendanceDateTime BETWEEN ? AND ?
        GROUP BY PersonID
      ) raw ON daily.PersonID = raw.PersonID
      GROUP BY daily.PersonID, raw.rawRecordCount
    `;

    const modSql = `
      SELECT personID AS PersonID, COUNT(*) AS modRecordCount
      FROM attendancerecord
      WHERE date BETWEEN ? AND ?
      GROUP BY personID
    `;

    const punchSql = `
      SELECT
        PersonID,
        MAX(PersonName) AS PersonName,
        COUNT(*) AS totalDays,
        SUM(CASE WHEN has_t1 = 1 THEN 1 ELSE 0 END) AS daysWithTimeIn,
        SUM(CASE WHEN has_t2 = 1 THEN 1 ELSE 0 END) AS daysWithBreakIn,
        SUM(CASE WHEN has_t3 = 1 THEN 1 ELSE 0 END) AS daysWithBreakOut,
        SUM(CASE WHEN has_t4 = 1 THEN 1 ELSE 0 END) AS daysWithTimeOut
      FROM (
        SELECT
          PersonID,
          PersonName,
          ${manilaYmdSql()} AS dt,
          MAX(CASE WHEN AttendanceState = 1 THEN 1 ELSE 0 END) AS has_t1,
          MAX(CASE WHEN AttendanceState = 2 THEN 1 ELSE 0 END) AS has_t2,
          MAX(CASE WHEN AttendanceState = 3 THEN 1 ELSE 0 END) AS has_t3,
          MAX(CASE WHEN AttendanceState = 4 THEN 1 ELSE 0 END) AS has_t4
        FROM AttendanceRecordInfo
        WHERE AttendanceDateTime BETWEEN ? AND ?
        GROUP BY PersonID, PersonName, dt
      ) daily
      GROUP BY PersonID
      ORDER BY PersonName ASC
    `;

    const run = (sql, params) =>
      new Promise((resolve, reject) => {
        db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });

    Promise.all([
      run(usersSql, [startTimestamp, endTimestamp]),
      run(summarySql, [startTimestamp, endTimestamp, startTimestamp, endTimestamp]),
      run(modSql, [sd, ed]),
      run(punchSql, [startTimestamp, endTimestamp]),
    ])
      .then(([users, summary, modSummary, punchInsights]) => {
        res.json({ users, summary, modSummary, punchInsights });
      })
      .catch((err) => {
        console.error('device-insights-bundle error:', err);
        res.status(500).json({ error: err.message });
      });
  });

  // Aggregated day counts per employee for a date range
  router.post('/api/device-attendance-summary', authenticateToken, (req, res) => {
    const { startDate, endDate } = req.body || {};

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startTimestamp, endTimestamp } = manilaDayRangeMs(startDate, endDate);

    const sql = `
      SELECT
        daily.PersonID,
        COUNT(*) AS recordsCount,
        IFNULL(raw.rawRecordCount, 0) AS rawRecordCount
      FROM (
        SELECT
          PersonID,
          ${manilaYmdSql()} AS dt
        FROM AttendanceRecordInfo
        WHERE AttendanceDateTime BETWEEN ? AND ?
        GROUP BY PersonID, dt
      ) daily
      LEFT JOIN (
        SELECT PersonID, COUNT(*) AS rawRecordCount
        FROM AttendanceRecordInfo
        WHERE AttendanceDateTime BETWEEN ? AND ?
        GROUP BY PersonID
      ) raw ON daily.PersonID = raw.PersonID
      GROUP BY daily.PersonID, raw.rawRecordCount
    `;

    db.query(sql, [startTimestamp, endTimestamp, startTimestamp, endTimestamp], (err, results) => {
      if (err) {
        console.error('Error fetching device attendance summary:', err);
        return res.status(500).json({ error: err.message });
      }

      res.json(results);
    });
  });

  // Modification record counts per employee from attendancerecord for a date range
  router.post('/api/device-modification-summary', authenticateToken, (req, res) => {
    const { startDate, endDate } = req.body || {};

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const sql = `
      SELECT
        personID AS PersonID,
        COUNT(*) AS modRecordCount
      FROM attendancerecord
      WHERE date BETWEEN ? AND ?
      GROUP BY personID
    `;

    db.query(sql, [startDate, endDate], (err, results) => {
      if (err) {
        console.error('Error fetching device modification summary:', err);
        return res.status(500).json({ error: err.message });
      }

      res.json(results);
    });
  });

  // Per-employee punch bracket consistency for a date range
  router.post('/api/device-punch-insights', authenticateToken, (req, res) => {
    const { startDate, endDate } = req.body || {};

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const { startTimestamp, endTimestamp } = manilaDayRangeMs(startDate, endDate);

    const sql = `
      SELECT
        PersonID,
        MAX(PersonName) AS PersonName,
        COUNT(*) AS totalDays,
        SUM(CASE WHEN has_t1 = 1 THEN 1 ELSE 0 END) AS daysWithTimeIn,
        SUM(CASE WHEN has_t2 = 1 THEN 1 ELSE 0 END) AS daysWithBreakIn,
        SUM(CASE WHEN has_t3 = 1 THEN 1 ELSE 0 END) AS daysWithBreakOut,
        SUM(CASE WHEN has_t4 = 1 THEN 1 ELSE 0 END) AS daysWithTimeOut
      FROM (
        SELECT
          PersonID,
          PersonName,
          ${manilaYmdSql()} AS dt,
          MAX(CASE WHEN AttendanceState = 1 THEN 1 ELSE 0 END) AS has_t1,
          MAX(CASE WHEN AttendanceState = 2 THEN 1 ELSE 0 END) AS has_t2,
          MAX(CASE WHEN AttendanceState = 3 THEN 1 ELSE 0 END) AS has_t3,
          MAX(CASE WHEN AttendanceState = 4 THEN 1 ELSE 0 END) AS has_t4
        FROM AttendanceRecordInfo
        WHERE AttendanceDateTime BETWEEN ? AND ?
        GROUP BY PersonID, PersonName, dt
      ) daily
      GROUP BY PersonID
      ORDER BY PersonName ASC
    `;

    db.query(sql, [startTimestamp, endTimestamp], (err, results) => {
      if (err) {
        console.error('Error fetching device punch insights:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results || []);
    });
  });

  // Aggregated device attendance list for the Attendance Device tab.
  router.post('/api/device-attendance-list', authenticateToken, async (req, res) => {
    const { startDate, endDate } = req.body || {};
    const limitRaw = Number.parseInt(req.body?.limit, 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 2000)
      : 1000;
    const hasRange = Boolean(startDate && endDate);
    const sd = hasRange ? String(startDate).slice(0, 10) : null;
    const ed = hasRange ? String(endDate).slice(0, 10) : null;
    const { startTimestamp, endTimestamp } = hasRange
      ? manilaDayRangeMs(sd, ed)
      : { startTimestamp: null, endTimestamp: null };

    const baseDailySql = `
      SELECT
        ari.PersonID,
        MAX(ari.PersonName) AS PersonName,
        ${manilaYmdSql('ari.AttendanceDateTime')} AS Date,
        MIN(CASE WHEN ari.AttendanceState = 1 THEN ari.AttendanceDateTime END) AS Time1,
        MIN(CASE WHEN ari.AttendanceState = 2 THEN ari.AttendanceDateTime END) AS Time2,
        MIN(CASE WHEN ari.AttendanceState = 3 THEN ari.AttendanceDateTime END) AS Time3,
        MAX(CASE WHEN ari.AttendanceState = 4 THEN ari.AttendanceDateTime END) AS Time4,
        MIN(CASE WHEN ari.AttendanceState = 5 THEN ari.AttendanceDateTime END) AS Time5,
        MAX(CASE WHEN ari.AttendanceState = 6 THEN ari.AttendanceDateTime END) AS Time6
      FROM AttendanceRecordInfo ari
      ${hasRange ? 'WHERE ari.AttendanceDateTime BETWEEN ? AND ?' : ''}
      GROUP BY ari.PersonID, Date
      ORDER BY Date DESC, PersonName ASC
      ${hasRange ? '' : 'LIMIT ?'}
    `;

    const sql = `
      SELECT
        daily.PersonID AS employeeNumber,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', p.firstName, p.middleName, p.lastName, p.nameExtension)), ''),
          NULLIF(daily.PersonName, ''),
          daily.PersonID
        ) AS fullName,
        COALESCE(da.code, '') AS department,
        daily.Date AS date,
        DAYNAME(daily.Date) AS day,
        daily.Time1,
        daily.Time2,
        daily.Time3,
        daily.Time4,
        daily.Time5,
        daily.Time6,
        ar.manually_modified,
        ar.timeIN AS savedTimeIN,
        ar.breaktimeIN AS savedBreaktimeIN,
        ar.breaktimeOUT AS savedBreaktimeOUT,
        ar.timeOUT AS savedTimeOUT,
        ar.specialTimeIN AS savedSpecialTimeIN,
        ar.specialTimeOUT AS savedSpecialTimeOUT
      FROM (${baseDailySql}) daily
      INNER JOIN users u
        ON TRIM(CAST(u.employeeNumber AS CHAR)) = TRIM(CAST(daily.PersonID AS CHAR))
      LEFT JOIN person_table p
        ON TRIM(CAST(p.agencyEmployeeNum AS CHAR)) = TRIM(CAST(daily.PersonID AS CHAR))
      LEFT JOIN (
        SELECT employeeNumber, MAX(code) AS code
        FROM department_assignment
        GROUP BY employeeNumber
      ) da
        ON TRIM(CAST(da.employeeNumber AS CHAR)) = TRIM(CAST(daily.PersonID AS CHAR))
      LEFT JOIN attendancerecord ar
        ON TRIM(CAST(ar.personID AS CHAR)) = TRIM(CAST(daily.PersonID AS CHAR))
        AND ar.date = daily.Date
      ORDER BY daily.Date DESC, fullName ASC
    `;

    const params = hasRange ? [startTimestamp, endTimestamp] : [limit];

    try {
      const rows = await new Promise((resolve, reject) => {
        db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result || [])));
      });

      const records = rows.map((row) => ({
        employeeNumber: row.employeeNumber,
        fullName: row.fullName,
        department: row.department || '',
        date: normalizeDateYmd(row.date),
        day: row.day || getDayOfWeek(row.date),
        timeIn: row.Time1 ? formatTime(convertDeviceMillisToManila(row.Time1)) : null,
        breakIn: row.Time3 ? formatTime(convertDeviceMillisToManila(row.Time3)) : null,
        breakOut: row.Time2 ? formatTime(convertDeviceMillisToManila(row.Time2)) : null,
        timeOut: row.Time4 ? formatTime(convertDeviceMillisToManila(row.Time4)) : null,
        specialTimeIn: row.Time5 ? formatTime(convertDeviceMillisToManila(row.Time5)) : null,
        specialTimeOut: row.Time6 ? formatTime(convertDeviceMillisToManila(row.Time6)) : null,
        manuallyModified: Number(row.manually_modified) === 1,
        savedTimeIN: row.savedTimeIN || null,
        savedBreaktimeIN: row.savedBreaktimeIN || null,
        savedBreaktimeOUT: row.savedBreaktimeOUT || null,
        savedTimeOUT: row.savedTimeOUT || null,
        savedSpecialTimeIN: row.savedSpecialTimeIN || null,
        savedSpecialTimeOUT: row.savedSpecialTimeOUT || null,
      }));

      res.json({ records, count: records.length, ranged: hasRange });
    } catch (err) {
      console.error('device-attendance-list error:', err);
      res.status(500).json({ error: err.message || 'Database error' });
    }
  });

  // Auto-save and fetch attendance records
  router.post('/api/all-attendance', authenticateToken, async (req, res) => {
    const { personID, startDate, endDate } = req.body;
    const syncDeviceToRecords = req.body.syncDeviceToRecords !== false;

    const { startTimestamp, endTimestamp } = manilaDayRangeMs(startDate, endDate);

    const query = `
      SELECT
        PersonID, PersonName,
        ${manilaYmdSql()} AS Date,
        MIN(CASE WHEN AttendanceState = 1 THEN AttendanceDateTime END) AS Time1,
        MIN(CASE WHEN AttendanceState = 2 THEN AttendanceDateTime END) AS Time2,
        MIN(CASE WHEN AttendanceState = 3 THEN AttendanceDateTime END) AS Time3,
        MAX(CASE WHEN AttendanceState = 4 THEN AttendanceDateTime END) AS Time4,
        MIN(CASE WHEN AttendanceState = 5 THEN AttendanceDateTime END) AS Time5,
        MAX(CASE WHEN AttendanceState = 6 THEN AttendanceDateTime END) AS Time6
      FROM AttendanceRecordInfo
      WHERE PersonID = ? AND AttendanceDateTime BETWEEN ? AND ?
      GROUP BY Date, PersonID, PersonName
      HAVING Date BETWEEN ? AND ?
      ORDER BY Date ASC
    `;

    const rangeStart = String(startDate || '').slice(0, 10);
    const rangeEnd = String(endDate || startDate || '').slice(0, 10);

    db.query(
      query,
      [personID, startTimestamp, endTimestamp, rangeStart, rangeEnd],
      async (err, results) => {
        if (err) {
          console.error('Error fetching attendance:', err);
          return res.status(500).json({ error: err.message });
        }

        const convertToManilaTime = (timestamp) => {
          if (!timestamp) return null;
          const date = new Date(timestamp);
          return date.toLocaleString('en-PH', {
            timeZone: 'Asia/Manila',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          });
        };

        const inRangeRows = (results || []).filter((row) =>
          ymdInInclusiveRange(row.Date, rangeStart, rangeEnd),
        );

        const records = inRangeRows.map((record) => ({
          PersonID: record.PersonID,
          PersonName: record.PersonName,
          Date: record.Date,
          Time1: convertToManilaTime(record.Time1),
          Time2: convertToManilaTime(record.Time2),
          Time3: convertToManilaTime(record.Time3),
          Time4: convertToManilaTime(record.Time4),
          Time5: convertToManilaTime(record.Time5),
          Time6: convertToManilaTime(record.Time6),
        }));

        let savedCount = 0;
        let updatedCount = 0;
        let syncFailedCount = 0;
        const syncErrors = [];

        if (syncDeviceToRecords) {
          try {
            const syncStats = await syncAggregatedDeviceDays(inRangeRows, {
              formatTime,
              getDayOfWeek,
              determineSpecialType,
              safeSpecialTypeForDb,
              toManilaTime: convertDeviceMillisToManila,
            });
            savedCount = syncStats.saved;
            updatedCount = syncStats.updated;
            syncFailedCount = syncStats.failed;
            syncErrors.push(...(syncStats.errors || []));
          } catch (syncErr) {
            console.error('Device sync batch failed:', syncErr);
            syncFailedCount = inRangeRows.length;
            syncErrors.push({ error: syncErr?.message || String(syncErr) });
          }

          if (savedCount > 0 || updatedCount > 0) {
            notifyAttendanceChanged('auto-sync', {
              scope: 'device-auto-save',
              personID, startDate, endDate,
              saved: savedCount, updated: updatedCount,
            });
          }
        }

        const syncMeta = {
          enabled: syncDeviceToRecords,
          saved: savedCount,
          updated: updatedCount,
          failed: syncFailedCount,
          attempted: inRangeRows.length,
          errors: syncErrors,
        };

        const syncTargetName =
          req.body.targetEmployeeName ||
          results[0]?.PersonName ||
          records[0]?.PersonName ||
          null;

        if (req.body.auditButton) {
          logAttendanceDeviceButton(req, {
            button: req.body.auditButton,
            targetEmployeeNumber: personID,
            targetName: syncTargetName,
            periodStart: startDate,
            periodEnd: endDate,
            monthLabel: req.body.monthLabel || null,
            searchQuery: req.body.searchQuery || null,
            extra: {
              records_loaded: records.length,
              device_saved: savedCount,
              device_updated: updatedCount,
            },
          });
        } else if (
          syncDeviceToRecords &&
          (savedCount > 0 || updatedCount > 0)
        ) {
          logAttendanceDeviceButton(req, {
            button: 'Auto-synced device records',
            targetEmployeeNumber: personID,
            targetName: syncTargetName,
            periodStart: startDate,
            periodEnd: endDate,
            extra: {
              device_saved: savedCount,
              device_updated: updatedCount,
            },
          });
        }

        const normYmd = (d) => {
          if (!d) return '';
          if (d instanceof Date && !Number.isNaN(d.getTime())) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
          }
          const s = String(d);
          return s.length >= 10 ? s.slice(0, 10) : s;
        };

        let enrichedRecords = records;
        if (records.length > 0) {
          const uniqueDates = [
            ...new Set(
              records.map((r) => normYmd(r.Date)).filter(Boolean),
            ),
          ];
          const specialByDate = {};
          if (uniqueDates.length > 0) {
            await new Promise((resolve, reject) => {
              const placeholders = uniqueDates.map(() => '?').join(',');
              const batchSql = `
                SELECT ar.date, ar.specialType, ar.specialTimeIN, ar.specialTimeOUT,
                      ar.manually_modified, ar.modified_at, ar.modified_by,
                      ${MODIFIER_NAME_SELECT}
                FROM attendancerecord ar
                ${MODIFIER_NAME_JOINS}
                WHERE ar.personID = ? AND ar.date IN (${placeholders})
              `;
              db.query(
                batchSql,
                [personID, ...uniqueDates],
                (err, rows) => {
                  if (err) return reject(err);
                  for (const row of rows || []) {
                    const key = normYmd(row.date);
                    if (key) specialByDate[key] = row;
                  }
                  resolve();
                },
              );
            });
          }
          enrichedRecords = records.map((record) => {
            const key = normYmd(record.Date);
            const specialData = key ? specialByDate[key] : null;
            return {
              ...record,
              specialType: specialData?.specialType || null,
              savedSpecialTimeIN: specialData?.specialTimeIN || null,
              savedSpecialTimeOUT: specialData?.specialTimeOUT || null,
              manually_modified: specialData?.manually_modified ?? 0,
              modified_at: specialData?.modified_at ?? null,
              modified_by: specialData?.modified_by ?? null,
              modified_by_name: specialData?.modified_by_name ?? null,
            };
          });
        }

        res.json({ records: enrichedRecords, sync: syncMeta });
      },
    );
  });

  // Bulk auto-save for all users in date range (batched — no per-user N+1)
  router.post('/api/bulk-auto-save', authenticateToken, async (req, res) => {
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    try {
      const { startTimestamp, endTimestamp } = manilaDayRangeMs(startDate, endDate);

      const records = await new Promise((resolve, reject) => {
        db.query(
          `
            SELECT
              PersonID, PersonName,
              ${manilaYmdSql()} AS Date,
              MIN(CASE WHEN AttendanceState = 1 THEN AttendanceDateTime END) AS Time1,
              MIN(CASE WHEN AttendanceState = 2 THEN AttendanceDateTime END) AS Time2,
              MIN(CASE WHEN AttendanceState = 3 THEN AttendanceDateTime END) AS Time3,
              MAX(CASE WHEN AttendanceState = 4 THEN AttendanceDateTime END) AS Time4,
              MIN(CASE WHEN AttendanceState = 5 THEN AttendanceDateTime END) AS Time5,
              MAX(CASE WHEN AttendanceState = 6 THEN AttendanceDateTime END) AS Time6
            FROM AttendanceRecordInfo
            WHERE AttendanceDateTime BETWEEN ? AND ?
            GROUP BY Date, PersonID, PersonName
            HAVING Date BETWEEN ? AND ?
          `,
          [startTimestamp, endTimestamp, startDate, endDate],
          (err, result) => {
            if (err) reject(err);
            else resolve(result || []);
          },
        );
      });

      const convertToManilaTime = (timestamp) => {
        if (!timestamp) return null;
        const date = new Date(timestamp);
        return date.toLocaleString('en-PH', {
          timeZone: 'Asia/Manila',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
        });
      };

      const syncStats = await syncAggregatedDeviceDays(records, {
        formatTime,
        getDayOfWeek,
        determineSpecialType,
        safeSpecialTypeForDb,
        toManilaTime: convertToManilaTime,
      });

      const savedCount = syncStats.saved;
      const updatedCount = syncStats.updated;
      const errorCount = syncStats.failed;
      const uniqueUsers = new Set(
        records.map((r) => String(r.PersonID ?? '').trim()).filter(Boolean),
      ).size;

      logAudit(req.user, 'bulk-auto-save', 'Device Attendance Records', `${startDate} && ${endDate}`, null);

      if (savedCount > 0 || updatedCount > 0) {
        notifyAttendanceChanged('bulk-auto-sync', {
          scope: 'device-bulk-auto-save',
          startDate, endDate,
          saved: savedCount, updated: updatedCount, errors: errorCount,
        });
      }

      res.json({
        success: true,
        message: `Processed ${uniqueUsers} users: ${savedCount} new records saved, ${updatedCount} records updated${errorCount > 0 ? `, ${errorCount} errors` : ''}`,
        stats: {
          totalUsers: uniqueUsers,
          dayRows: records.length,
          saved: savedCount,
          updated: updatedCount,
          errors: errorCount,
          skipped: syncStats.skipped,
        },
      });
    } catch (error) {
      console.error('Error in bulk auto-save:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // DTR Print Status
  router.post('/api/dtr-print-status', authenticateToken, async (req, res) => {
    const { employeeNumbers, year, month } = req.body;

    if (!employeeNumbers || !Array.isArray(employeeNumbers) || employeeNumbers.length === 0) {
      return res.status(400).json({ error: 'employeeNumbers array is required' });
    }

    if (!year || !month) {
      return res.status(400).json({ error: 'year and month are required' });
    }

    const query = `
      SELECT CAST(employee_number AS CHAR) AS employee_number,
             year, month, printed_at, printed_by
      FROM dtr_print_history
      WHERE employee_number IN (?) AND year = ? AND month = ?
    `;

    const empNums = employeeNumbers.map((n) => String(n).trim()).filter(Boolean);
    const yearNum = Number(year);
    const monthNum = Number(month);

    db.query(query, [empNums, yearNum, monthNum], (err, results) => {
      if (err) {
        console.error('Error fetching print status:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(results);
    });
  });

  // Mark DTRs as printed
  router.post('/api/mark-dtr-printed', authenticateToken, async (req, res) => {
    const { employeeNumbers, year, month, startDate, endDate } = req.body;

    if (!employeeNumbers || !Array.isArray(employeeNumbers) || employeeNumbers.length === 0) {
      return res.status(400).json({ error: 'employeeNumbers array is required' });
    }

    if (!year || !month || !startDate || !endDate) {
      return res.status(400).json({ error: 'year, month, startDate, and endDate are required' });
    }

    const printedBy = req.user.employeeNumber || req.user.username;
    const yearNum = Number(year);
    const monthNum = Number(month);
    const empNums = employeeNumbers.map((n) => String(n).trim()).filter(Boolean);

    const values = empNums.map((empNum) => [
      empNum, yearNum, monthNum, startDate, endDate, printedBy,
    ]);

    const query = `
      INSERT INTO dtr_print_history 
      (employee_number, year, month, start_date, end_date, printed_by)
      VALUES ?
      ON DUPLICATE KEY UPDATE 
        printed_at = CURRENT_TIMESTAMP,
        printed_by = VALUES(printed_by),
        start_date = VALUES(start_date),
        end_date = VALUES(end_date)
    `;

    db.query(query, [values], (err, result) => {
      if (err) {
        console.error('Error marking DTRs as printed:', err);
        return res.status(500).json({ error: err.message });
      }

      logAudit(
        req.user,
        `Printed DTR Records`,
        'Daily Time Record Overall',
        `${startDate} to ${endDate}`,
        empNums.join(', '),
      );

      notifyAttendanceChanged('dtr-printed', {
        scope: 'dtr_print_history',
        employeeNumbers: empNums,
        year: yearNum,
        month: monthNum,
        startDate,
        endDate,
        printedBy,
      });

      res.json({
        success: true,
        count: result.affectedRows,
        message: `Successfully marked ${empNums.length} DTR(s) as printed`,
      });
    });
  });

  // Get suspensions within date range
  router.get('/api/suspensions', authenticateToken, (req, res) => {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const query = `
      SELECT id, title, reason, date, date_start, date_end, image,
      COALESCE(personnel_scope, 'all') AS personnel_scope,
      COALESCE(suspension_type, 'whole_day') AS suspension_type,
      effective_time,
      branch
      FROM suspensions
      WHERE
        (date IS NOT NULL AND date BETWEEN ? AND ?)
        OR
        (date_start IS NOT NULL AND date_end IS NOT NULL AND date_start <= ? AND date_end >= ?)
    `;

    const params = [startDate, endDate, endDate, startDate];

    db.query(query, params, (err, rows) => {
      if (err) {
        console.error('Error fetching holidays:', err);
        return res.status(500).json({ error: err.message });
      }

      const byDate = {};

      const classify = (title = '', reason = '') => {
        const t = `${title} ${reason}`.toLowerCase();
        if (t.includes('work') && t.includes('susp')) return 'WORK SUSPENDED';
        if (t.includes('susp')) return 'WORK SUSPENDED';
        return 'ON LEAVE';
      };

      (rows || []).forEach((r) => {
        const single = calendarYmd(r.date);
        const start = calendarYmd(r.date_start);
        const end = calendarYmd(r.date_end);
        const label = classify(r.title, r.reason);

        const entry = {
          label,
          title: r.title,
          reason: r.reason,
          id: r.id,
          personnel_scope: r.personnel_scope || 'all',
          suspension_type: r.suspension_type || 'whole_day',
          effective_time: r.effective_time || null,
          branch: r.branch !== null && r.branch !== undefined ? Number(r.branch) : null,
        };

        if (start && end) {
          forEachYmdInRange(start, end, (key) => pushByDateEntry(byDate, key, entry));
        } else if (single) {
          pushByDateEntry(byDate, single, entry);
        }
      });

      const requestedBy = req.user?.employeeNumber || req.user?.username || 'unknown';
      notifyAttendanceChanged('suspensions-fetched', { scope: 'suspensions', startDate, endDate, requestedBy });

      return res.json({ success: true, count: Object.keys(byDate).length, byDate });
    });
  });

  // Get approved leaves within date range
  router.get('/api/leaves', authenticateToken, (req, res) => {
    const { startDate, endDate, personId, employeeNumber } = req.query;
    const employeeKey = String(personId || employeeNumber || '').trim();

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    let leaveQuery = `
      SELECT lr.id, lr.leave_date, lr.leave_code, lt.leave_description
      FROM leave_request lr
      JOIN leave_table lt ON lr.leave_code = lt.leave_code
      WHERE lr.status = 2
      AND lr.leave_date BETWEEN ? AND ?
    `;
    const leaveParams = [startDate, endDate];
    if (employeeKey) {
      leaveQuery += ' AND lr.employeeNumber = ?';
      leaveParams.push(employeeKey);
    }

    db.query(leaveQuery, leaveParams, (err, rows) => {
      if (err) {
        console.error('Error fetching leaves:', err);
        return res.status(500).json({ error: err.message });
      }

      const toISO = (d) => calendarYmd(d);

      const byDate = {};
      (rows || []).forEach((leave) => {
        const leaveDate = toISO(leave.leave_date);
        if (!leaveDate || byDate[leaveDate]) return;
        const leaveLabel =
          String(leave.leave_description || leave.leave_code || 'ON LEAVE').trim() ||
          'ON LEAVE';
        byDate[leaveDate] = {
          label: leaveLabel,
          title: leaveLabel,
          leave_description: leave.leave_description,
          leave_code: leave.leave_code,
          reason: 'Approved Leave',
          id: leave.id,
        };
      });

      const requestedBy = req.user?.employeeNumber || req.user?.username || 'unknown';
      notifyAttendanceChanged('leaves-fetched', { scope: 'leaves', startDate, endDate, personId: employeeKey || undefined, requestedBy });

      return res.json({ success: true, count: Object.keys(byDate).length, byDate });
    });
  });

  // Get holidays within date range
  router.get('/api/holiday', authenticateToken, (req, res) => {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const query = `
    SELECT id, title, about, description, date, date_start, date_end, image, status, branch
      FROM holiday
      WHERE
         (
        (date IS NOT NULL AND date BETWEEN ? AND ?)
        OR
        (date_start IS NOT NULL AND date_end IS NOT NULL AND date_start <= ? AND date_end >= ?)
      )
      AND (status IS NULL OR status = 'Active')
    `;

    const params = [startDate, endDate, endDate, startDate];

    db.query(query, params, (err, rows) => {
      if (err) {
        console.error('Error fetching suspensions:', err);
        return res.status(500).json({ error: err.message });
      }

      const byDate = {};

      (rows || []).forEach((r) => {
        const single = calendarYmd(r.date);
        const start = calendarYmd(r.date_start);
        const end = calendarYmd(r.date_end);
        const label = 'HOLIDAY';
        const reason = r.about || r.description || 'Holiday';
        const entry = {
          label,
          title: r.title,
          reason,
          id: r.id,
          branch: r.branch !== null && r.branch !== undefined ? Number(r.branch) : null,
        };

        if (start && end) {
          forEachYmdInRange(start, end, (key) => pushByDateEntry(byDate, key, entry));
        } else if (single) {
          pushByDateEntry(byDate, single, entry);
        }
      });

      const requestedBy = req.user?.employeeNumber || req.user?.username || 'unknown';
      notifyAttendanceChanged('holidays-fetched', { scope: 'holiday', startDate, endDate, requestedBy });

      return res.json({ success: true, count: Object.keys(byDate).length, byDate });
    });
  });

  // Fetch ALL days in range (including days with no record)
  router.post('/api/view-attendance-full', authenticateToken, (req, res) => {
    const { personID, startDate, endDate } = req.body;

    if (!personID || !startDate || !endDate) {
      return res.status(400).json({ error: 'personID, startDate, endDate are required.' });
    }

    const query = `
      WITH RECURSIVE date_series AS (
        SELECT CAST(? AS DATE) AS cal_date
        UNION ALL
        SELECT DATE_ADD(cal_date, INTERVAL 1 DAY)
        FROM   date_series
        WHERE  cal_date < CAST(? AS DATE)
      )
      SELECT
        ? AS personID,
        DATE_FORMAT(ds.cal_date, '%Y-%m-%d')  AS date,
        DAYNAME(ds.cal_date)                   AS Day,
        ar.id          AS recordId,
        ar.timeIN, ar.breaktimeIN, ar.breaktimeOUT, ar.timeOUT,
        ar.remarks, ar.autofill_remarks,
        ar.manually_modified, ar.modified_at, ar.modified_by,
        ${MODIFIER_NAME_SELECT},
        ar.specialType, ar.specialTimeIN, ar.specialTimeOUT,
        p.firstName, p.lastName, p.middleName, p.agencyEmployeeNum,
        ot.officialTimeIN, ot.officialTimeOUT,
        ot.officialBreaktimeIN, ot.officialBreaktimeOUT,
        ot.officialHonorariumTimeIN, ot.officialHonorariumTimeOUT,
        ot.officialServiceCreditTimeIN, ot.officialServiceCreditTimeOUT,
        ot.officialOverTimeIN, ot.officialOverTimeOUT
      FROM date_series ds
      LEFT JOIN person_table p   ON p.agencyEmployeeNum = ?
      LEFT JOIN attendancerecord ar ON ar.personID = ? AND ar.date = DATE_FORMAT(ds.cal_date, '%Y-%m-%d')
      ${MODIFIER_NAME_JOINS}
      LEFT JOIN officialtime ot
            ON ot.employeeID = ?
            AND ot.day        = DAYNAME(ds.cal_date)
            AND ds.cal_date   BETWEEN ot.startDate AND ot.endDate
      ORDER BY ds.cal_date ASC;
    `;

    db.query(
      query,
      [startDate, endDate, personID, personID, personID, personID],
      (err, results) => {
        if (err) {
          console.error('view-attendance-full error:', err);
          return res.status(500).json({ error: err.message });
        }

        const tagged = results.map((row) => ({
          ...row,
          isNew:        row.recordId == null,
          timeIN:       row.timeIN       ?? '',
          breaktimeIN:  row.breaktimeIN  ?? '',
          breaktimeOUT: row.breaktimeOUT ?? '',
          timeOUT:      row.timeOUT      ?? '',
        }));

        res.json(tagged);
      },
    );
  });

  // ─── UPSERT full-month records ────────────────────────────────────────────────
  // FIX: remarks (global save reason) is ONLY written to rows that were actually
  // changed. changedDateKeys is an optional array of date strings sent by the
  // frontend. For rows NOT in that set, remarks is left untouched (CASE … ELSE).
  router.put('/api/view-attendance-full', authenticateToken, async (req, res) => {
    const { records, remarks, changedDateKeys } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array is required.' });
    }

    // Build Set for O(1) lookup
    const changedSet = Array.isArray(changedDateKeys)
      ? new Set(changedDateKeys)
      : null;

    const isEmpty = (v) => !v || String(v).trim() === '';

    try {
      let inserted = 0, updated = 0, skipped = 0;
      const modifiedBy =
        (req.user && (req.user.employeeNumber || req.user.username)) || null;

      for (const record of records) {
        const allEmpty =
          isEmpty(record.timeIN) && isEmpty(record.breaktimeIN) &&
          isEmpty(record.breaktimeOUT) && isEmpty(record.timeOUT);

        // Per-record autofill_remarks
        const autofillRemarks =
          record.autofill_remarks != null
            ? String(record.autofill_remarks).trim() || null
            : null;

        // ── Determine if this row should receive the global remarks ──────────
        // For INSERT rows: always write remarks (they are new, admin initiated).
        // For UPDATE rows: only write if date is in changedSet (or changedSet
        // wasn't supplied, in which case we trust the record is in the batch
        // because it was changed — full-month only sends changed rows).
        const rowReceivesRemarks = record.isNew
          ? true
          : changedSet ? changedSet.has(record.date) : true;

        const remarksToWrite = rowReceivesRemarks ? (remarks || null) : null;
        // ────────────────────────────────────────────────────────────────────

        // ── INSERT path ───────────────────────────────────────────────────────
        if (record.isNew) {
          if (allEmpty) { skipped++; continue; }

          const checkSql = `SELECT id FROM attendancerecord WHERE personID = ? AND date = ? LIMIT 1`;
          const existing = await new Promise((resolve, reject) => {
            db.query(checkSql, [record.personID, record.date], (err, rows) => {
              if (err) reject(err); else resolve(rows[0] ?? null);
            });
          });

          if (existing) {
            const updateSql = `
              UPDATE attendancerecord
              SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ?,
                  remarks = CASE WHEN ? IS NOT NULL THEN ? ELSE remarks END,
                  autofill_remarks = COALESCE(?, autofill_remarks),
                  manually_modified = 1,
                  modified_at = NOW(),
                  modified_by = ?
              WHERE id = ?
            `;
            await new Promise((resolve, reject) => {
              db.query(
                updateSql,
                [
                  record.timeIN || null, record.breaktimeIN || null,
                  record.breaktimeOUT || null, record.timeOUT || null,
                  remarksToWrite, remarksToWrite,
                  autofillRemarks,
                  modifiedBy,
                  existing.id,
                ],
                (err) => { if (err) reject(err); else resolve(); },
              );
            });
            updated++;
            logAudit(req.user,
              `Updated Attendance Record (full-month, race-condition) | ${record.date}${remarksToWrite ? ` | Remarks: ${remarksToWrite}` : ''}${autofillRemarks ? ` | AutoFill: ${autofillRemarks}` : ''}`,
              'Attendance Modification – Full View', record.date, record.personID);

            const changes = ['timeIN', 'breaktimeIN', 'breaktimeOUT', 'timeOUT']
              .filter((f) => record[f] && String(record[f]).trim() !== '')
              .map((f) => ({ field: f, before: '', after: record[f] }));
    writeAdjustmentLog(db, req, {
              personID: record.personID, date: record.date, dayOfWeek: record.Day,
              operationType: 'UPDATE', remarks: remarksToWrite, autofillRemarks, changes,
            });

          } else {
            const insertSql = `
              INSERT INTO attendancerecord
                (personID, date, Day, timeIN, breaktimeIN, breaktimeOUT, timeOUT,
                remarks, autofill_remarks, manually_modified, modified_at, modified_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), ?)
            `;
            await new Promise((resolve, reject) => {
              db.query(
                insertSql,
                [
                  record.personID, record.date, record.Day,
                  record.timeIN || null, record.breaktimeIN || null,
                  record.breaktimeOUT || null, record.timeOUT || null,
                  remarksToWrite,
                  autofillRemarks,
                  modifiedBy,
                ],
                (err) => { if (err) reject(err); else resolve(); },
              );
            });
            inserted++;
            logAudit(req.user,
              `Inserted New Attendance Record (full-month) | ${record.date}${remarksToWrite ? ` | Remarks: ${remarksToWrite}` : ''}${autofillRemarks ? ` | AutoFill: ${autofillRemarks}` : ''}`,
              'Attendance Modification – Full View', record.date, record.personID);

            const changes = ['timeIN', 'breaktimeIN', 'breaktimeOUT', 'timeOUT']
              .filter((f) => record[f] && String(record[f]).trim() !== '')
              .map((f) => ({ field: f, before: null, after: record[f] }));
      writeAdjustmentLog(db, req, {
              personID: record.personID, date: record.date, dayOfWeek: record.Day,
              operationType: 'INSERT', remarks: remarksToWrite, autofillRemarks, changes,
            });
          }

        // ── UPDATE path ───────────────────────────────────────────────────────
        } else {
          const fetchSql = `
            SELECT timeIN, breaktimeIN, breaktimeOUT, timeOUT, Day
            FROM attendancerecord
            WHERE personID = ? AND date = ?
          `;
          const oldRow = await new Promise((resolve, reject) => {
            db.query(fetchSql, [record.personID, record.date], (err, rows) => {
              if (err) reject(err); else resolve(rows[0] ?? {});
            });
          });

          const normalize = (v) => (v == null ? '' : String(v).trim());
          const FIELDS = ['timeIN', 'breaktimeIN', 'breaktimeOUT', 'timeOUT'];
          const changes = FIELDS
            .filter((f) => normalize(oldRow[f]) !== normalize(record[f]))
            .map((f) => ({
              field:  f,
              before: normalize(oldRow[f]),
              after:  normalize(record[f]),
            }));

          const LABELS = {
            timeIN: 'Time IN', breaktimeIN: 'Breaktime IN',
            breaktimeOUT: 'Breaktime OUT', timeOUT: 'Time OUT',
          };
          const diffStr = changes
            .map(({ field, before, after }) =>
              `${LABELS[field] || field}: [${before || 'empty'} → ${after || 'empty'}]`
            )
            .join(' | ');

          const updateSql = changes.length > 0
            ? `
            UPDATE attendancerecord
            SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ?,
                remarks = CASE WHEN ? IS NOT NULL THEN ? ELSE remarks END,
                autofill_remarks = COALESCE(?, autofill_remarks),
                manually_modified = 1,
                modified_at = NOW(),
                modified_by = ?
            WHERE personID = ? AND date = ?
          `
            : `
            UPDATE attendancerecord
            SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ?,
                remarks = CASE WHEN ? IS NOT NULL THEN ? ELSE remarks END,
                autofill_remarks = COALESCE(?, autofill_remarks)
            WHERE personID = ? AND date = ?
          `;
          await new Promise((resolve, reject) => {
            db.query(
              updateSql,
              changes.length > 0
                ? [
                    record.timeIN || null, record.breaktimeIN || null,
                    record.breaktimeOUT || null, record.timeOUT || null,
                    remarksToWrite, remarksToWrite,
                    autofillRemarks,
                    modifiedBy,
                    record.personID, record.date,
                  ]
                : [
                    record.timeIN || null, record.breaktimeIN || null,
                    record.breaktimeOUT || null, record.timeOUT || null,
                    remarksToWrite, remarksToWrite,
                    autofillRemarks,
                    record.personID, record.date,
                  ],
              (err) => { if (err) reject(err); else resolve(); },
            );
          });
          updated++;

          if (diffStr) {
            logAudit(req.user,
              `Updated Attendance Record (full-month) | ${record.date} | ${diffStr}${remarksToWrite ? ` | Remarks: ${remarksToWrite}` : ''}${autofillRemarks ? ` | AutoFill: ${autofillRemarks}` : ''}`,
              'Attendance Modification – Full View', record.date, record.personID);

        writeAdjustmentLog(db, req, {
              personID: record.personID, date: record.date,
              dayOfWeek: oldRow.Day || record.Day || null,
              operationType: 'UPDATE', remarks: remarksToWrite, autofillRemarks, changes,
            });
          }
        }
      }

      const personIDs = [...new Set(records.map((r) => r.personID).filter(Boolean))];
      notifyAttendanceChanged('full-month-updated', {
        scope: 'attendancerecord', personIDs, inserted, updated,
      });

      res.json({
        message: `Saved successfully. ${inserted} inserted, ${updated} updated, ${skipped} skipped.`,
        inserted, updated, skipped,
      });
    } catch (err) {
      console.error('view-attendance-full PUT error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/attendance_adjustment ──────────────────────────────────────────
  router.get('/api/attendance_adjustment', authenticateToken, (req, res) => {
    const {
      personID,
      dateFrom,
      dateTo,
      adjustmentType,
      operationType,
      department,
      source,
      employeeName,
    } = req.query;

    let sql = `
      SELECT
        aal.id,
        aal.personID          AS employeeNumber,
        aal.originalDate,
        aal.dayOfWeek,
        aal.fieldName,
        aal.adjustmentType,
        aal.valueBefore,
        aal.valueAfter,
        aal.operationType,
        aal.remarks,
        aal.autofill_remarks,
        aal.approvedBy,
        aal.adjustedAt,
        CONCAT_WS(' ', pt.firstName, pt.lastName)   AS employeeName,
        COALESCE(da.code, '—')                       AS department
      FROM attendance_adjustment_log aal
      LEFT JOIN person_table pt
        ON pt.agencyEmployeeNum = aal.personID
      LEFT JOIN department_assignment da
        ON da.employeeNumber = aal.personID
      WHERE 1 = 1
    `;

    const params = [];

    if (personID) {
      sql += ' AND aal.personID = ?';
      params.push(String(personID).trim());
    }
    if (dateFrom) {
      sql += ' AND aal.originalDate >= ?';
      params.push(String(dateFrom).slice(0, 10));
    }
    if (dateTo) {
      sql += ' AND aal.originalDate <= ?';
      params.push(String(dateTo).slice(0, 10));
    }
    if (adjustmentType && adjustmentType !== 'all') {
      sql += ' AND aal.adjustmentType = ?';
      params.push(String(adjustmentType));
    }
    if (operationType && operationType !== 'all') {
      sql += ' AND aal.operationType = ?';
      params.push(String(operationType));
    }
    if (department && department !== 'all') {
      sql += ' AND da.code = ?';
      params.push(String(department));
    }
    if (source === 'autofill') {
      sql += " AND aal.autofill_remarks IS NOT NULL AND TRIM(aal.autofill_remarks) <> ''";
    } else if (source === 'manual') {
      sql += " AND (aal.autofill_remarks IS NULL OR TRIM(aal.autofill_remarks) = '')";
    }
    if (employeeName && String(employeeName).trim()) {
      sql +=
        " AND CONCAT_WS(' ', pt.firstName, pt.middleName, pt.lastName) LIKE ?";
      params.push(`%${String(employeeName).trim()}%`);
    }

    sql += ' ORDER BY aal.adjustedAt DESC';

    db.query(sql, params, (err, rows) => {
      if (err) {
        console.error('GET /api/attendance_adjustment error:', err);
        return res.status(500).json({ error: err.message });
      }

      logAudit(
        req.user,
        'Viewed Attendance Adjustment Report',
        'attendance_adjustment_log',
        personID || 'all',
        req.user?.employeeNumber || null,
      );

      res.json(rows);
    });
  });

  /**
  * Restore one attendancerecord row from raw AttendanceRecordInfo punches.
  * @returns {{ success: boolean, personID: string, date: string, error?: string, restoredFromManual?: boolean, remarksCleared?: boolean }}
  */
  const restoreSingleRowFromDevice = async (db, req, personID, date, opts = {}) => {
    const {
      skipAudit = false,
      skipNotify = false,
      remarksOverride = null,
      operationType = 'DEVICE-RESTORE',
      adjustmentNote = null,
    } = opts;
    const personKey = String(personID ?? '').trim();
    const dateYmd = normalizeDateYmd(date);
    if (!personKey || !dateYmd) {
      return { success: false, personID: personKey, date: dateYmd, error: 'Invalid personID or date' };
    }

    const { startTimestamp, endTimestamp } = manilaDayRangeMs(dateYmd, dateYmd);

    const deviceQuery = `
      SELECT
        PersonID, PersonName,
        ${manilaYmdSql()} AS Date,
        MIN(CASE WHEN AttendanceState = 1 THEN AttendanceDateTime END) AS Time1,
        MIN(CASE WHEN AttendanceState = 2 THEN AttendanceDateTime END) AS Time2,
        MIN(CASE WHEN AttendanceState = 3 THEN AttendanceDateTime END) AS Time3,
        MAX(CASE WHEN AttendanceState = 4 THEN AttendanceDateTime END) AS Time4,
        MIN(CASE WHEN AttendanceState = 5 THEN AttendanceDateTime END) AS Time5,
        MAX(CASE WHEN AttendanceState = 6 THEN AttendanceDateTime END) AS Time6
      FROM AttendanceRecordInfo
      WHERE PersonID = ? AND AttendanceDateTime BETWEEN ? AND ?
      GROUP BY Date, PersonID, PersonName
      HAVING Date = ?
      LIMIT 1
    `;

    const deviceRows = await new Promise((resolve, reject) => {
      db.query(deviceQuery, [personKey, startTimestamp, endTimestamp, dateYmd], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    if (deviceRows.length === 0) {
      return {
        success: false,
        personID: personKey,
        date: dateYmd,
        error: 'No device punch data found for this employee and date',
      };
    }

    const raw = deviceRows[0];

    const officialTimeQuery = `
      SELECT 
        officialTimeIN, officialTimeOUT,
        officialBreaktimeIN, officialBreaktimeOUT,
        officialHonorariumTimeIN, officialHonorariumTimeOUT,
        officialServiceCreditTimeIN, officialServiceCreditTimeOUT,
        officialOverTimeIN, officialOverTimeOUT
      FROM officialtime
      WHERE employeeID = ? 
        AND DAYNAME(?) = day
        AND ? BETWEEN startDate AND endDate
    `;

    const officialTimeData = await new Promise((resolve, reject) => {
      db.query(officialTimeQuery, [personKey, dateYmd, dateYmd], (err, result) => {
        if (err) reject(err);
        else resolve(result[0] || null);
      });
    });

    const fetchSql = `
      SELECT timeIN, breaktimeIN, breaktimeOUT, timeOUT, day,
            specialType, specialTimeIN, specialTimeOUT,
            remarks, autofill_remarks, manually_modified
      FROM attendancerecord
      WHERE personID = ? AND date = ?
      LIMIT 1
    `;
    const oldRow = await new Promise((resolve, reject) => {
      db.query(fetchSql, [personKey, dateYmd], (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0] || null);
      });
    });

    const newTimeIN = formatTime(convertDeviceMillisToManila(raw.Time1));
    const newBreaktimeIN = formatTime(convertDeviceMillisToManila(raw.Time3));
    const newBreaktimeOUT = formatTime(convertDeviceMillisToManila(raw.Time2));
    const newTimeOUT = formatTime(convertDeviceMillisToManila(raw.Time4));
    const newDay = getDayOfWeek(dateYmd);

    let specialType = null;
    let specialTimeIN = null;
    let specialTimeOUT = null;

    if (raw.Time5 || raw.Time6) {
      const specialTime = convertDeviceMillisToManila(raw.Time5 || raw.Time6);
      const specialResult = determineSpecialType(specialTime, officialTimeData);
      specialType = safeSpecialTypeForDb(specialResult.type);
      specialTimeIN = raw.Time5
        ? formatTime(convertDeviceMillisToManila(raw.Time5))
        : null;
      specialTimeOUT = raw.Time6
        ? formatTime(convertDeviceMillisToManila(raw.Time6))
        : null;
    }

    const normalize = (v) => (v == null ? '' : String(v).trim());
    const wasManuallyModified = Number(oldRow?.manually_modified) === 1;
    const hadRemarks =
      !!normalize(oldRow?.remarks) || !!normalize(oldRow?.autofill_remarks);
    const shouldSetRestoreRemark = wasManuallyModified || hadRemarks;
    const restoreRemarkText = remarksOverride
      ?? (shouldSetRestoreRemark ? DEVICE_RESTORE_REMARK : '');
    const restoreNote = adjustmentNote
      ?? 'Restored from raw device punches — returned to default (admin remarks cleared)';

    const newValues = {
      timeIN: newTimeIN,
      breaktimeIN: newBreaktimeIN,
      breaktimeOUT: newBreaktimeOUT,
      timeOUT: newTimeOUT,
      specialType,
      specialTimeIN,
      specialTimeOUT,
      remarks: restoreRemarkText,
      autofill_remarks: '',
    };
    const TRACK_FIELDS = [
      'timeIN', 'breaktimeIN', 'breaktimeOUT', 'timeOUT',
      'specialType', 'specialTimeIN', 'specialTimeOUT',
      'remarks', 'autofill_remarks',
    ];
    const changes = TRACK_FIELDS
      .filter((f) => normalize(oldRow?.[f]) !== normalize(newValues[f]))
      .map((f) => ({
        field: f,
        before: normalize(oldRow?.[f]),
        after: normalize(newValues[f]),
      }));

    if (oldRow) {
      const updateSql = `
        UPDATE attendancerecord
        SET timeIN = ?, breaktimeIN = ?, breaktimeOUT = ?, timeOUT = ?,
            specialType = ?, specialTimeIN = ?, specialTimeOUT = ?, day = ?,
            remarks = ?, autofill_remarks = NULL,
            manually_modified = 0, modified_at = NULL, modified_by = NULL
        WHERE personID = ? AND date = ?
      `;
      await new Promise((resolve, reject) => {
        db.query(
          updateSql,
          [
            newTimeIN, newBreaktimeIN, newBreaktimeOUT, newTimeOUT,
            specialType, specialTimeIN, specialTimeOUT, newDay,
            restoreRemarkText || null,
            personKey, dateYmd,
          ],
          (err) => { if (err) reject(err); else resolve(); },
        );
      });
    } else {
      const insertSql = `
        INSERT INTO attendancerecord
          (personID, date, day, timeIN, breaktimeIN, breaktimeOUT, timeOUT,
          specialType, specialTimeIN, specialTimeOUT,
          remarks, manually_modified, modified_at, modified_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
      `;
      await new Promise((resolve, reject) => {
        db.query(
          insertSql,
          [
            personKey, dateYmd, newDay,
            newTimeIN, newBreaktimeIN, newBreaktimeOUT, newTimeOUT,
            specialType, specialTimeIN, specialTimeOUT,
            restoreRemarkText || null,
          ],
          (err) => { if (err) reject(err); else resolve(); },
        );
      });
    }

    const diffStr = changes
      .map(({ field, before, after }) => `${field}: [${before || 'empty'} → ${after || 'empty'}]`)
      .join(' | ');

    if (!skipAudit) {
      logAudit(
        req.user,
        `Restored Attendance from Device | ${dateYmd}${diffStr ? ` | ${diffStr}` : ''}${hadRemarks ? ' | Remarks cleared' : ''}`,
        'Attendance Device',
        dateYmd,
        personKey,
      );
    }

    if (changes.length > 0) {
      writeAdjustmentLog(db, req, {
        personID: personKey,
        date: dateYmd,
        dayOfWeek: oldRow?.day || newDay,
        operationType,
        remarks: restoreNote,
        autofillRemarks: null,
        changes,
      });
    }

    if (!skipNotify) {
      notifyAttendanceChanged('device-restore', {
        scope: 'force-sync-from-device',
        personID: personKey,
        date: dateYmd,
      });
    }

    return {
      success: true,
      personID: personKey,
      date: dateYmd,
      restoredFromManual: wasManuallyModified || hadRemarks,
      remarksCleared: hadRemarks,
      timeIN: newTimeIN,
      breaktimeIN: newBreaktimeIN,
      breaktimeOUT: newBreaktimeOUT,
      timeOUT: newTimeOUT,
      specialType,
      specialTimeIN,
      specialTimeOUT,
    };
  };

  // Update a single raw device punch status (AttendanceRecordInfo.AttendanceState)
  router.patch('/api/attendance-record-state', authenticateToken, async (req, res) => {
    const { personID, attendanceDateTime, attendanceState } = req.body || {};
    const personKey = String(personID ?? '').trim();
    const ts = Number(attendanceDateTime);
    const newState = Number(attendanceState);

    if (
      !personKey ||
      !Number.isFinite(ts) ||
      !Number.isInteger(newState) ||
      newState < 1 ||
      newState > 6
    ) {
      return res.status(400).json({
        error: 'personID, attendanceDateTime, and attendanceState (1–6) are required',
      });
    }

    try {
      const existing = await new Promise((resolve, reject) => {
        db.query(
          `SELECT AttendanceState FROM AttendanceRecordInfo WHERE PersonID = ? AND AttendanceDateTime = ? LIMIT 1`,
          [personKey, ts],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows[0] || null);
          },
        );
      });

      if (!existing) {
        return res.status(404).json({ error: 'Attendance record not found' });
      }

      const previousState = Number(existing.AttendanceState);
      if (previousState === newState) {
        return res.json({
          message: 'No change',
          previousState,
          attendanceState: newState,
        });
      }

      await new Promise((resolve, reject) => {
        db.query(
          `UPDATE AttendanceRecordInfo SET AttendanceState = ? WHERE PersonID = ? AND AttendanceDateTime = ?`,
          [newState, personKey, ts],
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      const dateYmd = new Date(ts).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Manila',
      });
      const stateRemark = buildStateCorrectionRemark(previousState, newState);

      let dtrRestored = false;
      try {
        const restoreResult = await restoreSingleRowFromDevice(db, req, personKey, dateYmd, {
          skipAudit: true,
          skipNotify: true,
          remarksOverride: stateRemark,
          operationType: 'STATE-STATUS',
          adjustmentNote: `Punch status corrected in Attendance State (${attendanceStateLabel(previousState)} → ${attendanceStateLabel(newState)})`,
        });
        dtrRestored = restoreResult?.success === true;
      } catch (restoreErr) {
        console.warn('attendance-record-state: DTR restore skipped:', restoreErr.message);
      }

      await new Promise((resolve, reject) => {
        db.query(
          `UPDATE attendancerecord SET remarks = ? WHERE personID = ? AND date = ?`,
          [stateRemark, personKey, dateYmd],
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          },
        );
      });

      logAudit(
        req.user,
        `Updated punch state ${previousState} → ${newState} | ${dateYmd}`,
        'Attendance State',
        `${personKey}|${ts}`,
        personKey,
        {
          personID: personKey,
          attendanceDateTime: ts,
          previousState,
          newState,
          date: dateYmd,
          dtrRestored,
        },
      );

      notifyAttendanceChanged('attendance-state-updated', {
        scope: 'attendancerecordinfo',
        personIDs: [personKey],
        personID: personKey,
        date: dateYmd,
      });

      res.json({
        message: 'Attendance status updated',
        previousState,
        attendanceState: newState,
        date: dateYmd,
        dtrRestored,
      });
    } catch (err) {
      console.error('PATCH /api/attendance-record-state error:', err);
      res.status(500).json({ error: err.message || 'Failed to update attendance status' });
    }
  });

  // Force-restore a single row from raw device punches (clears manual lock)
  router.post('/api/force-sync-from-device', authenticateToken, async (req, res) => {
    const { personID, date } = req.body || {};

    if (!personID || !date) {
      return res.status(400).json({ error: 'personID and date are required' });
    }

    try {
      const result = await restoreSingleRowFromDevice(db, req, personID, date);
      if (!result.success) {
        return res.status(result.error?.includes('No device') ? 404 : 400).json({ error: result.error });
      }

      res.json({
        ...result,
        message: result.restoredFromManual
          ? 'Returned data from the device — admin remarks cleared'
          : 'Row restored from device data',
      });
    } catch (err) {
      console.error('force-sync-from-device error:', err);
      res.status(500).json({ error: err.message || 'Failed to restore from device' });
    }
  });

  // Bulk force-restore locked rows from raw device punches
  router.post('/api/bulk-force-sync-from-device', authenticateToken, async (req, res) => {
    const { rows } = req.body || {};

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required' });
    }
    if (rows.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 rows per bulk restore request' });
    }

    let restored = 0;
    let failed = 0;
    const errors = [];
    const restoredRows = [];

    try {
      for (const row of rows) {
        const personID = row?.personID;
        const date = row?.date;
        if (!personID || !date) {
          failed++;
          errors.push({ personID, date, error: 'personID and date are required' });
          continue;
        }

        try {
          const result = await restoreSingleRowFromDevice(db, req, personID, date, {
            skipAudit: true,
            skipNotify: true,
          });
          if (result.success) {
            restored++;
            restoredRows.push({
              personID: result.personID,
              date: result.date,
              restoredFromManual: result.restoredFromManual,
            });
          } else {
            failed++;
            errors.push({
              personID: result.personID,
              date: result.date,
              error: result.error || 'Restore failed',
            });
          }
        } catch (rowErr) {
          failed++;
          errors.push({
            personID,
            date,
            error: rowErr?.message || String(rowErr),
          });
        }
      }

      if (restored > 0) {
        const personIDs = [...new Set(restoredRows.map((r) => r.personID).filter(Boolean))];
        const dates = [...new Set(restoredRows.map((r) => r.date).filter(Boolean))];

        logAudit(
          req.user,
          `Bulk Restored Attendance from Device | ${restored} row(s)${failed ? `, ${failed} failed` : ''}`,
          'Attendance Device',
          dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`,
          personIDs.length === 1 ? personIDs[0] : personIDs.join(', '),
        );

        notifyAttendanceChanged('device-restore-bulk', {
          scope: 'bulk-force-sync-from-device',
          personIDs,
          dates,
          restored,
          failed,
        });
      }

      res.json({
        success: true,
        restored,
        failed,
        restoredRows,
        errors: errors.slice(0, 20),
        message:
          restored > 0
            ? `Restored ${restored} row(s) from device data${failed ? ` (${failed} failed)` : ''}`
            : 'No rows were restored',
      });
    } catch (err) {
      console.error('bulk-force-sync-from-device error:', err);
      res.status(500).json({ error: err.message || 'Bulk restore failed' });
    }
  });

  module.exports = router;
