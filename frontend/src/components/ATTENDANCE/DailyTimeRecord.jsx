  import API_BASE_URL from '../../apiConfig';
  import React, { useEffect, useState, useRef, useCallback } from 'react';
  import axios from 'axios';
  import { useSocket } from '../../contexts/SocketContext';
  import LoadingOverlay from '../LoadingOverlay';
  import { jwtDecode } from 'jwt-decode';
  import { AccessTime, CalendarToday, Refresh } from '@mui/icons-material';
  import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
  import PrintIcon from '@mui/icons-material/Print';
  import {
    Box,
    Button,
    Card,
    Checkbox,
    CircularProgress,
    Fade,
    FormControlLabel,
    IconButton,
    Paper,
    styled,
    Tooltip,
    Typography,
    Snackbar,
    Alert,
    Grid,
  } from '@mui/material';
  import earistLogo from '../../assets/earistLogo.png';
  import { useSystemSettings } from '../../hooks/useSystemSettings';
  import { alpha } from '@mui/material/styles';
  import usePageAccess from '../../hooks/usePageAccess';
  import AccessDenied from '../AccessDenied';
  import {
    AttendanceFilterHeader,
    AttendanceFilterSectionLabel,
    AttendanceFilterDateControls,
    applyQuickDateRange,
    filterPanelScrollSx,
    filterSidebarCardSx,
    attendanceMainPanelHeightSx,
    MONTHS_SHORT,
    ATTENDANCE_COMPACT_PAGE_SX,
    useAttendanceCompactPage,
  } from './attendanceFilterLayout';
  import {
    fetchDailyLateUndertime,
    parseHalfDayDatesSet,
    DTR_COMPUTED_LATE_UPDATE_EVENT,
    DTR_COMPUTED_LATE_STORAGE_KEY,
  } from '../../utils/dtrLateUndertimeFromOverall';
  import { personnelScopeFromEmployment } from '../../utils/earningsEmpCatRules';
  import {
    buildReviewByDate,
    parseHalfDayReviewJson,
    parseSuggestedHalfDayDatesFromReview,
    MODULE_TYPES,
  } from '../../utils/halfDayReview';
  import DTRTemplate from './DTRTemplate';
  import {
    DTRPrintStyles,
    printDtrHtml,
    downloadDtrHtml,
  } from './DailyTimeRecordPrintable';
  import {
    fetchEmployeeDisplayName,
    formatDtrPdfFileName,
  } from '../../utils/dtrFormatHelpers';
  import { fetchEmployeeBranch } from './attendanceLeaveIntegration';

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  const generateHash = (data) => {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).toUpperCase();
  };

  /** YYYY-MM-DD as a Philippines calendar day (fixes holiday/leave off-by-one from UTC-midnight ISO strings). */
  const toPhCalendarYmd = (value) => {
    if (value == null || value === '') return '';
    const s = String(value).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : '';
    }
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d);
      const y = parts.find((p) => p.type === 'year')?.value;
      const mo = parts.find((p) => p.type === 'month')?.value;
      const da = parts.find((p) => p.type === 'day')?.value;
      if (y && mo && da) return `${y}-${mo}-${da}`;
    } catch {
      /* ignore */
    }
    return s.split('T')[0];
  };

  const recordMatchesDay = (record, dayPadded) => {
    const ymd = toPhCalendarYmd(record?.date);
    if (!ymd || dayPadded.length !== 2) return false;
    return ymd.endsWith(`-${dayPadded}`);
  };

  /**
   * Map an employee's computed attendance module type to the same coarse
   * "personnel scope" bucket used on suspension records (personnel_scope).
   * DTR-DISPLAY ONLY — does not touch late/undertime calculation, which
   * already has its own identical helper in computeModuleLateUndertimeForDtr.js.
   */
  const scopeForModuleType = (mod) => {
    if (mod === MODULE_TYPES.NON_TEACHING) return 'non_teaching';
    if (
      mod === MODULE_TYPES.FACULTY_30HRS ||
      mod === MODULE_TYPES.DESIGNATED_40HRS
    ) {
      return 'academic';
    }
    return null;
  };

  const resolveEmployeeSuspensionScope = (moduleType, employmentCategory) => {
    const fromMod = scopeForModuleType(moduleType);
    if (fromMod) return fromMod;
    return personnelScopeFromEmployment(employmentCategory);
  };

  // ─── DESIGN TOKENS (unified with DailyTimeRecordFaculty / Payslip) ───────────
  const T = {
    accent: '#6d2323',
    accentDark: '#5a1d1d',
    accentMid: '#8B4545',
    accentFaint: 'rgba(109,35,35,0.06)',
    accentBorder: 'rgba(109,35,35,0.14)',
    accentHover: 'rgba(109,35,35,0.10)',
    rowEven: '#ffffff',
    rowOdd: 'rgba(109,35,35,0.025)',
    rowHover: 'rgba(109,35,35,0.055)',
    text: '#1a1a1a',
    muted: '#6b6b6b',
    faint: '#a0a0a0',
    surface: '#ffffff',
    divider: 'rgba(0,0,0,0.08)',
  };

  const scrollbarSx = {
    '&::-webkit-scrollbar': { width: 4 },
    '&::-webkit-scrollbar-thumb': { bgcolor: T.accentBorder, borderRadius: 2 },
    '&::-webkit-scrollbar-track': { bgcolor: 'transparent' },
  };

  // ─── STYLED COMPONENTS (kept local, same tokens as the hub view) ─────────────

  const SectionCard = styled(Card)({
    borderRadius: 12,
    boxShadow: '0 1px 4px rgba(0,0,0,0.07), 0 4px 24px rgba(0,0,0,0.04)',
    border: '0.5px solid rgba(0,0,0,0.09)',
    overflow: 'hidden',
    background: T.surface,
  });

  const AccentButton = styled(Button)({
    borderRadius: 8,
    textTransform: 'none',
    fontWeight: 600,
    fontSize: '0.875rem',
    letterSpacing: '0.01em',
    transition: 'all 0.18s ease',
    '&:hover': { transform: 'translateY(-1px)' },
    '&:active': { transform: 'translateY(0)' },
  });

  const FormSectionLabel = ({ icon: Icon, children }) => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
      <Icon sx={{ fontSize: 12, color: alpha(T.accent, 0.45) }} />
      <Typography
        sx={{
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: alpha(T.accent, 0.45),
        }}
      >
        {children}
      </Typography>
    </Box>
  );

  // ─── COMPONENT ────────────────────────────────────────────────────────────────

  const DailyTimeRecord = () => {
    const { socket, connected } = useSocket();
    const { settings } = useSystemSettings();

    // ── Core state ─────────────────────────────────────────────────────────────
    const [personID, setPersonID] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [records, setRecords] = useState([]);
    const [employeeName, setEmployeeName] = useState('');
    const [employeeNameParts, setEmployeeNameParts] = useState({
      firstName: '',
      lastName: '',
      middleName: '',
    });
    const [pdfDownloadLoading, setPdfDownloadLoading] = useState(false);
    const [officialTimes, setOfficialTimes] = useState({});
    const [showOfficialTimeOnDtr, setShowOfficialTimeOnDtr] = useState(false);
    const dtrRef = useRef(null);
    const [selectedMonth, setSelectedMonth] = useState(null);
    const [holidays, setHolidays] = useState([]);
    const [suspensions, setSuspensions] = useState([]);
    const [approvedLeaves, setApprovedLeaves] = useState([]);
    const [computedLateByDate, setComputedLateByDate] = useState({});
    const [halfDayDatesSet, setHalfDayDatesSet] = useState(() => new Set());
    const [suggestedHalfDayDatesSet, setSuggestedHalfDayDatesSet] = useState(
      () => new Set(),
    );
    const [halfDayReviewByDate, setHalfDayReviewByDate] = useState({});
    const [computationModuleType, setComputationModuleType] = useState(null);
    const [employmentCategory, setEmploymentCategory] = useState(null);
    const [employeeBranch, setEmployeeBranch] = useState(null);

    // ── Anti-tamper state ──────────────────────────────────────────────────────
    const [originalRecords, setOriginalRecords] = useState([]);
    const [recordsHash, setRecordsHash] = useState('');
    const [fetchedAt, setFetchedAt] = useState(null);
    const [snackbar, setSnackbar] = useState({
      open: false,
      message: '',
      severity: 'info',
    });

    // ── Anti-tamper refs ───────────────────────────────────────────────────────
    const observerRef = useRef(null);
    const restoreTimerRef = useRef(null);
    const originalRecordsRef = useRef([]);
    const isRestoringRef = useRef(false);
    const formatTimeRef = useRef(null);
    const fetchRequestSeqRef = useRef(0);

    // ── Loading state ────────────────────────────────────────────────────────
    const [monthLoading, setMonthLoading] = useState(false);

    // ── Year selector ──────────────────────────────────────────────────────────
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const currentYear = new Date().getFullYear();
    const yearOptions = Array.from({ length: 11 }, (_, i) => currentYear - 5 + i);

    // ── Initial-load flag (feeds the shared LoadingOverlay, no separate wireframe) ─
    const [pageLoading, setPageLoading] = useState(true);

    const monthsShort = MONTHS_SHORT;

    // ── Theme colours (kept for parity, unused for layout now) ────────────────
    const primaryColor = settings.accentColor || '#FEF9E1';
    const secondaryColor = settings.backgroundColor || '#FFF8E7';
    const accentColor = settings.primaryColor || '#6d2323';
    const accentDark = settings.secondaryColor || '#8B3333';
    const textPrimaryColor = settings.textPrimaryColor || '#6d2323';
    const textSecondaryColor = settings.textSecondaryColor || '#FEF9E1';

    // ── Access guard ───────────────────────────────────────────────────────────
    const { hasAccess, loading: accessLoading } =
      usePageAccess('daily-time-record');

    // Same compact page treatment as the hub (Faculty) DTR view.
    useAttendanceCompactPage();

    const getAuthHeaders = () => {
      const token = localStorage.getItem('token');
      return {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      };
    };

    // ── Decode token ────────────────────────────────────────────────────────────
    useEffect(() => {
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const decoded = jwtDecode(token);
          setPersonID(decoded.employeeNumber);
        } catch (err) {
          console.error('Error decoding token:', err);
        }
      }
    }, []);

    // ── Formatters ─────────────────────────────────────────────────────────────
    // Strip seconds — only keep HH:MM [AM/PM]
    const formatTime = useCallback((timeString) => {
      if (!timeString) return '';
      const cleaned = timeString.replace(/\s+/g, ' ').trim();
      // Match HH:MM:SS AM/PM or HH:MM:SS or HH:MM AM/PM
      const match = cleaned.match(/^(\d{1,2}:\d{2})(?::\d{2})?(\s*[AaPp][Mm])?/);
      if (match) {
        return (
          match[1] + (match[2] ? match[2].trim().toUpperCase() : '')
        ).trim();
      }
      return cleaned;
    }, []);

    useEffect(() => {
      formatTimeRef.current = formatTime;
    }, [formatTime]);

    // ── DOM restore logic ──────────────────────────────────────────────────────
    const restoreDOMFromOriginal = useCallback(() => {
      if (!dtrRef.current) return;
      const original = originalRecordsRef.current;
      if (!original || original.length === 0) return;
      isRestoringRef.current = true;
      const fmt = formatTimeRef.current || ((s) => s || '');
      const tbodies = dtrRef.current.querySelectorAll('tbody');
      tbodies.forEach((tbody) => {
        const rows = tbody.querySelectorAll('tr');
        rows.forEach((row) => {
          const dayCell = row.querySelector('td:first-child');
          if (!dayCell) return;
          const dayText = dayCell.textContent.trim();
          if (!/^\d{2}$/.test(dayText)) return;
          const record = original.find((r) => recordMatchesDay(r, dayText));
          if (!record) return;
          const cells = row.querySelectorAll('td');
          if (cells.length < 5) return;
          const timeValues = [
            fmt(record?.timeIN || ''),
            fmt(record?.breaktimeIN || ''),
            fmt(record?.breaktimeOUT || ''),
            fmt(record?.timeOUT || ''),
          ];
          [1, 2, 3, 4].forEach((cellIdx, spanIdx) => {
            // Target ONLY .dtr-actual-time — not watermark (HOLIDAY / SUSPENSION / ON LEAVE).
            const td = cells[cellIdx];
            if (!td) return;
            const span = td.querySelector(':scope > span.dtr-actual-time');
            if (span && span.textContent.trim() !== timeValues[spanIdx]) {
              span.textContent = timeValues[spanIdx];
            }
          });
        });
      });
      setTimeout(() => {
        isRestoringRef.current = false;
      }, 50);
    }, []);

    const startObserver = useCallback(() => {
      if (!dtrRef.current) return;
      if (observerRef.current) observerRef.current.disconnect();
      observerRef.current = new MutationObserver((mutations) => {
        if (isRestoringRef.current) return;
        const isTimeTamper = mutations.some((m) => {
          // Only guard punch-time cells (.dtr-actual-time), not late/undertime or watermarks.
          const target = m.target;
          const isInWatermark = (n) =>
            !!(n && n.closest && n.closest('.dtr-cell-watermark'));
          if (isInWatermark(target)) return false;
          const isActualTimeEl = (node) =>
            !!(node && node.closest && node.closest('.dtr-actual-time'));
          if (m.type === 'characterData') {
            if (target?.classList?.contains('dtr-actual-time')) return true;
            const span = target.parentElement;
            if (isInWatermark(span)) return false;
            return isActualTimeEl(span);
          }
          if (m.type === 'childList') {
            if (isActualTimeEl(target)) return true;
            return (
              target.tagName === 'TD' && target.querySelector('.dtr-actual-time')
            );
          }
          return false;
        });
        if (!isTimeTamper) return;
        if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = setTimeout(() => {
          restoreDOMFromOriginal();
        }, 300);
      });
      observerRef.current.observe(dtrRef.current, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }, [restoreDOMFromOriginal]);

    const stopObserver = useCallback(() => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (restoreTimerRef.current) {
        clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
    }, []);

    useEffect(() => {
      if (originalRecords.length > 0 && dtrRef.current) {
        const t = setTimeout(() => startObserver(), 100);
        return () => {
          clearTimeout(t);
          stopObserver();
        };
      } else {
        stopObserver();
      }
    }, [originalRecords, startObserver, stopObserver]);

    useEffect(() => () => stopObserver(), [stopObserver]);

    // ── Data fetching ───────────────────────────────────────────────────────────
    const fetchRecords = async () => {
      const requestSeq = ++fetchRequestSeqRef.current;
      setMonthLoading(true);
      try {
        const response = await axios.post(
          `${API_BASE_URL}/attendance/api/view-attendance`,
          { personID, startDate, endDate },
          getAuthHeaders(),
        );
        if (requestSeq !== fetchRequestSeqRef.current) return;
        const data = Array.isArray(response.data) ? response.data : [];
        const regularRecords = data.filter((r) => r.timeIN || r.timeOUT);
        if (data.length > 0) {
          stopObserver();
          setRecords(regularRecords);
          const immutable = Object.freeze(
            JSON.parse(JSON.stringify(regularRecords)),
          );
          setOriginalRecords(immutable);
          originalRecordsRef.current = immutable;
          const hash = generateHash(regularRecords);
          setRecordsHash(hash);
          setFetchedAt(new Date().toISOString());
          const { firstName, lastName, middleName } = data[0];
          const full =
            `${firstName || ''} ${middleName ? middleName + ' ' : ''}${lastName || ''}`.trim();
          setEmployeeName(full || 'Unknown');
          setEmployeeNameParts({
            firstName: firstName || '',
            lastName: lastName || '',
            middleName: middleName || '',
          });
          // Load official-time data in background so the main DTR overlay can close earlier.
          fetchOfficialTimes(personID, startDate, endDate, requestSeq);
          await loadComputedLateForDTR();
        } else {
          stopObserver();
          setRecords([]);
          const immutable = Object.freeze([]);
          setOriginalRecords(immutable);
          originalRecordsRef.current = immutable;
          setRecordsHash(generateHash([]));
          setFetchedAt(new Date().toISOString());
          setComputedLateByDate({});
          setHalfDayDatesSet(new Set());
          fetchOfficialTimes(personID, startDate, endDate, requestSeq);
          const name = await fetchEmployeeDisplayName(
            API_BASE_URL,
            personID,
            getAuthHeaders(),
          );
          if (name) setEmployeeName(name);
          else
            setEmployeeName((prev) =>
              prev && prev !== 'No records found' ? prev : '',
            );
          setEmployeeNameParts({
            firstName: '',
            lastName: '',
            middleName: '',
            fullName: name || '',
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (requestSeq === fetchRequestSeqRef.current) {
          setMonthLoading(false);
        }
      }
    };

    // ── FIX: Accept periodStart / periodEnd and filter schedules to that window ──
    const fetchOfficialTimes = async (
      employeeID,
      periodStart,
      periodEnd,
      requestSeq = null,
    ) => {
      try {
        const response = await axios.get(
          `${API_BASE_URL}/officialtimetable/${employeeID}`,
          getAuthHeaders(),
        );

        if (requestSeq != null && requestSeq !== fetchRequestSeqRef.current)
          return;

        const allRows = response.data || [];

        // Filter to only schedules whose date range overlaps the selected period.
        // If no period is provided (initial load), skip filtering.
        const filtered =
          periodStart && periodEnd
            ? allRows.filter((r) => {
                const schedStart = r.startDate
                  ? String(r.startDate).split('T')[0]
                  : null;
                const schedEnd = r.endDate
                  ? String(r.endDate).split('T')[0]
                  : null;
                if (!schedStart || !schedEnd) return false;
                // Overlap condition: sched starts before period ends AND sched ends after period starts
                return schedStart <= periodEnd && schedEnd >= periodStart;
              })
            : allRows;

        const map = filtered.reduce((acc, r) => {
          // Last-write-wins per day — higher id = more recent row takes precedence
          if (!acc[r.day] || (r.id && acc[r.day]._id && r.id > acc[r.day]._id)) {
            acc[r.day] = {
              _id: r.id,
              officialTimeIN: r.officialTimeIN,
              officialTimeOUT: r.officialTimeOUT,
              officialBreaktimeIN: r.officialBreaktimeIN,
              officialBreaktimeOUT: r.officialBreaktimeOUT,
            };
          }
          return acc;
        }, {});

        // Strip internal _id before storing
        const cleanMap = Object.fromEntries(
          Object.entries(map).map(([day, val]) => {
            const { _id, ...rest } = val;
            return [day, rest];
          }),
        );

        setOfficialTimes(cleanMap);
      } catch (err) {
        if (requestSeq != null && requestSeq !== fetchRequestSeqRef.current)
          return;
        console.error('Error fetching official times:', err);
        setOfficialTimes({});
      }
    };

    const fetchEmployeeProfileForSuspensions = async (empID) => {
      if (!empID) {
        setEmploymentCategory(null);
        return;
      }
      try {
        const empCatRes = await axios
          .get(
            // Only this employee's row: the list endpoint returns every
            // employee (~1 MB) and was downloaded on each DTR load.
            `${API_BASE_URL}/EmploymentCategoryRoutes/employment-category/${encodeURIComponent(empID)}`,
            getAuthHeaders(),
          )
          .catch(() => ({ data: null }));
        const match =
          empCatRes.data && String(empCatRes.data.employeeNumber) === String(empID)
            ? empCatRes.data
            : null;
        setEmploymentCategory(
          match
            ? {
                employmentCategory:
                  match.employmentCategory != null && match.employmentCategory !== ''
                    ? Number(match.employmentCategory)
                    : null,
                parentGroup: match.parentGroup || '',
                typeName: match.typeName || '',
                label:
                  match.parentGroup && match.typeName
                    ? `${match.parentGroup} | ${match.typeName}`
                    : match.categoryLabel || '',
              }
            : null,
        );
      } catch (err) {
        console.error('Error fetching employee category:', err);
        setEmploymentCategory(null);
      }
    };

    const fetchApprovedLeaves = async (empID) => {
      try {
        const response = await axios.get(
          `${API_BASE_URL}/leaveRoute/leave_request`,
          getAuthHeaders(),
        );
        const hrApproved = response.data.filter(
          (req) =>
            String(req.status) === '2' &&
            String(req.employeeNumber) === String(empID),
        );
        setApprovedLeaves(hrApproved);
      } catch (err) {
        console.error('Error fetching approved leaves:', err);
        setApprovedLeaves([]);
      }
    };

    // ── Initial load ────────────────────────────────────────────────────────────
    const initialLoadDone = useRef(false);
    useEffect(() => {
      if (!personID || initialLoadDone.current) return;
      initialLoadDone.current = true;
      const init = async () => {
        await Promise.allSettled([
          // Initial load: no period yet — fetchOfficialTimes will not filter
          fetchOfficialTimes(personID, null, null),
          fetchApprovedLeaves(personID),
          fetchEmployeeProfileForSuspensions(personID),
          axios
            .get(`${API_BASE_URL}/holiday`, getAuthHeaders())
            .then((r) => {
              setHolidays(Array.isArray(r.data) ? r.data : []);
            })
            .catch(() => setHolidays([])),
          axios
            .get(`${API_BASE_URL}/api/suspensions`, getAuthHeaders())
            .then((r) => {
              setSuspensions(Array.isArray(r.data) ? r.data : []);
            })
            .catch(() => setSuspensions([])),
        ]);
        setPageLoading(false);
      };
      init();
    }, [personID]); // eslint-disable-line react-hooks/exhaustive-deps

    // Campus branch for holiday/suspension filtering (same as pasted DTR behavior).
    useEffect(() => {
      const key = String(personID ?? '').trim();
      if (!key) {
        setEmployeeBranch(null);
        return;
      }
      let cancelled = false;
      fetchEmployeeBranch({
        apiBaseUrl: API_BASE_URL,
        getAuthHeaders,
        employeeNumber: key,
      }).then((branch) => {
        if (!cancelled) setEmployeeBranch(branch);
      });
      return () => {
        cancelled = true;
      };
    }, [personID]);

    const loadComputedLateForDTR = useCallback(async () => {
      if (!personID || !startDate || !endDate) {
        setComputedLateByDate({});
        setHalfDayDatesSet(new Set());
        setSuggestedHalfDayDatesSet(new Set());
        setHalfDayReviewByDate({});
        // Do not invent NON_TEACHING — that hid academic suspensions when the
        // computation module had not been saved yet for this period.
        setComputationModuleType(null);
        return;
      }
      const { byDate, halfDayDates, half_day_review, computation_module_type } =
        await fetchDailyLateUndertime(personID, startDate, endDate);
      setComputedLateByDate(byDate || {});
      setHalfDayDatesSet(parseHalfDayDatesSet(halfDayDates));
      setSuggestedHalfDayDatesSet(
        parseSuggestedHalfDayDatesFromReview(half_day_review),
      );
      setHalfDayReviewByDate(
        buildReviewByDate(parseHalfDayReviewJson(half_day_review)),
      );
      setComputationModuleType(computation_module_type || null);
    }, [personID, startDate, endDate]);

    useEffect(() => {
      if (personID && startDate && endDate) fetchRecords();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [personID, startDate, endDate]);

    useEffect(() => {
      const handleStorage = (event) => {
        if (event?.key && event.key !== DTR_COMPUTED_LATE_STORAGE_KEY) return;
        if (!personID || !startDate || !endDate) return;
        loadComputedLateForDTR();
      };

      const handleComputedLateUpdated = () => {
        if (!personID || !startDate || !endDate) return;
        loadComputedLateForDTR();
      };

      window.addEventListener('storage', handleStorage);
      window.addEventListener(
        DTR_COMPUTED_LATE_UPDATE_EVENT,
        handleComputedLateUpdated,
      );
      return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener(
          DTR_COMPUTED_LATE_UPDATE_EVENT,
          handleComputedLateUpdated,
        );
      };
    }, [personID, startDate, endDate, loadComputedLateForDTR]);

    const fetchRecordsRef = useRef(fetchRecords);
    fetchRecordsRef.current = fetchRecords;

    useEffect(() => {
      if (!socket || !connected) return;
      let debounceTimer = null;
      const handleAttendanceChanged = (payload) => {
        if (payload?.action === 'dtr-printed') return;
        if (
          payload?.action === 'overall-daily-late-updated' ||
          payload?.action === 'overall-daily-late-created'
        ) {
          return;
        }
        const scope = payload?.scope;
        if (scope === 'suspensions' || scope === 'leaves' || scope === 'holiday')
          return;
        const changedIDs = Array.isArray(payload?.personIDs)
          ? payload.personIDs
          : payload?.personID != null
            ? [payload.personID]
            : [];
        const isBulk = payload?.action === 'bulk-auto-sync';
        if (changedIDs.length === 0 && !isBulk) return;
        if (
          personID &&
          changedIDs.length > 0 &&
          !changedIDs.some((id) => String(id) === String(personID))
        )
          return;
        if (!personID || !startDate || !endDate) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          fetchRecordsRef.current?.();
        }, 120);
      };
      socket.on('attendanceChanged', handleAttendanceChanged);
      return () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        socket.off('attendanceChanged', handleAttendanceChanged);
      };
    }, [socket, connected, personID, startDate, endDate, loadComputedLateForDTR]);

    // ── Integrity verification ─────────────────────────────────────────────────
    const verifyIntegrity = () => {
      if (!fetchedAt) {
        setSnackbar({
          open: true,
          message: 'No DTR data loaded. Please search first.',
          severity: 'warning',
        });
        return false;
      }
      // Empty period is printable as a blank DTR (name + calendar banners).
      if (originalRecords.length === 0) return true;
      const ageMs = Date.now() - new Date(fetchedAt).getTime();
      if (ageMs > 30 * 60 * 1000) {
        setSnackbar({
          open: true,
          message: 'DTR data is older than 30 minutes. Please search again.',
          severity: 'warning',
        });
        return false;
      }
      const currentHash = generateHash(records);
      if (currentHash !== recordsHash) {
        setSnackbar({
          open: true,
          message: 'Data integrity check failed. Please reload.',
          severity: 'error',
        });
        return false;
      }
      return true;
    };

    // Print uses fast HTML; Download builds a PDF and auto-saves it
    // as: Surname, First Name, MI. Month, Year.pdf
    const resolveSinglePdfName = () =>
      formatDtrPdfFileName(
        {
          ...employeeNameParts,
          fullName: employeeName,
        },
        startDate,
      );

    const printPage = async () => {
      if (!dtrRef.current) return;
      if (!verifyIntegrity()) return;
      restoreDOMFromOriginal();
      await printDtrHtml(dtrRef.current, {
        title: resolveSinglePdfName().replace(/\.pdf$/i, ''),
      });
    };

    const downloadPDF = async () => {
      if (!dtrRef.current) return;
      if (!verifyIntegrity()) return;
      restoreDOMFromOriginal();
      setPdfDownloadLoading(true);
      try {
        await downloadDtrHtml(dtrRef.current, resolveSinglePdfName());
      } catch (error) {
        console.error('Error downloading DTR PDF:', error);
        setSnackbar({
          open: true,
          message: error?.message || 'Failed to download PDF.',
          severity: 'error',
        });
      } finally {
        setPdfDownloadLoading(false);
      }
    };

    // ── Month / quick-date selection (shared with the hub DTR view) ────────────
    const handleMonthClick = (monthIndex) => {
      const start = new Date(Date.UTC(selectedYear, monthIndex, 1));
      const end = new Date(Date.UTC(selectedYear, monthIndex + 1, 0));
      setStartDate(start.toISOString().substring(0, 10));
      setEndDate(end.toISOString().substring(0, 10));
      setSelectedMonth(monthIndex);
    };

    const handleQuickDateSelect = (value) => {
      applyQuickDateRange(value, setStartDate, setEndDate, setSelectedMonth);
      setRecords([]);
      setEmployeeName('');
      setEmployeeNameParts({ firstName: '', lastName: '', middleName: '' });
      setOfficialTimes({});
    };

    // ── Access guard ───────────────────────────────────────────────────────────
    if (!accessLoading && hasAccess === false) {
      return (
        <AccessDenied
          title="Access Denied"
          message="You do not have permission to access Daily Time Record. Contact your administrator to request access."
          returnPath="/admin-home"
          returnButtonText="Return to Home"
        />
      );
    }

    // Download PDF shows overlay while the file is built and saved.
    const loadingOverlayOpen =
      accessLoading || pageLoading || monthLoading || pdfDownloadLoading;

    const loadingOverlayMessage = (() => {
      if (accessLoading) return 'Checking access…';
      if (pageLoading) return 'Loading Daily Time Record…';
      if (pdfDownloadLoading) return 'Preparing PDF download…';
      if (monthLoading)
        return selectedMonth !== null
          ? `Loading DTR — ${monthsShort[selectedMonth]}…`
          : 'Loading DTR — Fetching records…';
      return 'Processing…';
    })();

    const dtrTemplateProps = {
      employeeName,
      records,
      officialTime: officialTimes,
      showOfficialTimeOnDtr,
      startDate,
      endDate,
      selectedYear,
      selectedMonth,
      holidays,
      suspensions,
      approvedLeaves,
      computedLateByDate: computedLateByDate,
      suggestedHalfDayDatesSet,
      halfDayReviewByDate,
      computationModuleType: computationModuleType || undefined,
      employeeScope: resolveEmployeeSuspensionScope(
        computationModuleType,
        employmentCategory,
      ),
      employmentCategory,
      // Always pass (incl. null) so DTRTemplate applies campus filter like the pasted DTR.
      employeeBranch,
      formatTime,
    };

    // ── Render ─────────────────────────────────────────────────────────────────
    return (
      <>
        <LoadingOverlay
          open={loadingOverlayOpen}
          message={loadingOverlayMessage}
          showDelayMs={pdfDownloadLoading ? 0 : 150}
        />
        <Snackbar
          open={snackbar.open}
          autoHideDuration={5000}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
            severity={snackbar.severity}
            variant="filled"
            sx={{ width: '100%', fontWeight: 600 }}
          >
            {snackbar.message}
          </Alert>
        </Snackbar>

        {!accessLoading && !pageLoading && (
          <Fade in timeout={500}>
            <Box>
              <DTRPrintStyles />

              <Box sx={ATTENDANCE_COMPACT_PAGE_SX}>
                {/* ── Page Header — unified with the hub (Faculty) DTR view ── */}
                <SectionCard
                  className="no-print"
                  sx={{ mb: 2, overflow: 'hidden' }}
                >
                  <Box
                    sx={{
                      px: 4,
                      py: 3,
                      background:
                        'linear-gradient(135deg,#fdf5f5 0%,#f0dede 100%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      position: 'relative',
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      sx={{
                        position: 'absolute',
                        top: -50,
                        right: -50,
                        width: 200,
                        height: 200,
                        borderRadius: '50%',
                        background:
                          'radial-gradient(circle, rgba(109,35,35,0.1) 0%, transparent 70%)',
                      }}
                    />
                    <Box
                      sx={{
                        position: 'absolute',
                        bottom: -30,
                        left: '30%',
                        width: 150,
                        height: 150,
                        borderRadius: '50%',
                        background:
                          'radial-gradient(circle, rgba(109,35,35,0.07) 0%, transparent 70%)',
                      }}
                    />
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 3,
                        position: 'relative',
                        zIndex: 1,
                      }}
                    >
                      <AccessTime sx={{ fontSize: 32, color: T.accent }} />
                      <Box>
                        <Typography
                          sx={{
                            fontSize: '1.25rem',
                            fontWeight: 900,
                            color: T.accent,
                            lineHeight: 1.2,
                            mb: 0.3,
                          }}
                        >
                          Daily Time Record
                        </Typography>
                        <Typography
                          sx={{
                            fontSize: '0.82rem',
                            color: T.accentMid,
                            fontWeight: 700,
                            opacity: 0.9,
                          }}
                        >
                          Employee Portal — view and download your DTR records
                        </Typography>
                      </Box>
                    </Box>
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.5,
                        position: 'relative',
                        zIndex: 1,
                      }}
                    >
                      <Box
                        sx={{
                          px: 2.5,
                          py: 0.75,
                          borderRadius: 6,
                          bgcolor: alpha(T.accent, 0.1),
                          border: `1px solid ${alpha(T.accent, 0.2)}`,
                        }}
                      >
                        <Typography
                          sx={{
                            fontSize: '0.8rem',
                            color: T.accent,
                            fontWeight: 700,
                          }}
                        >
                          {records.length} records
                        </Typography>
                      </Box>
                      <Tooltip title="Refresh Page">
                        <IconButton
                          onClick={() => window.location.reload()}
                          sx={{
                            bgcolor: alpha(T.accent, 0.08),
                            color: T.accent,
                            width: 36,
                            height: 36,
                            '&:hover': { bgcolor: alpha(T.accent, 0.15) },
                          }}
                        >
                          <Refresh sx={{ fontSize: 18 }} />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </Box>
                </SectionCard>

                {/* ── Two-column layout — same Grid + SectionCard rules as the hub view ── */}
                <Grid container spacing={2}>
                  {/* LEFT: shared filter sidebar */}
                  <Grid item xs={12} lg={3} className="no-print">
                    <SectionCard sx={filterSidebarCardSx}>
                      <AttendanceFilterHeader />
                      <Box sx={filterPanelScrollSx}>
                        {/* Employee (read-only, resolved from token) */}
                        <FormSectionLabel icon={AccessTime}>
                          Employee
                        </FormSectionLabel>
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: 1.5,
                            py: 1.1,
                            mb: 2.5,
                            borderRadius: '8px',
                            border: `1px dashed ${T.accentBorder}`,
                            bgcolor: alpha(T.accent, 0.03),
                            cursor: 'not-allowed',
                            userSelect: 'none',
                          }}
                        >
                          <AccessTime
                            sx={{
                              fontSize: 14,
                              color: alpha(T.accent, 0.4),
                              flexShrink: 0,
                            }}
                          />
                          <Typography
                            sx={{
                              fontSize: '0.82rem',
                              color: T.muted,
                              fontWeight: 600,
                              flex: 1,
                            }}
                          >
                            {personID || '—'}
                          </Typography>
                          <Box
                            sx={{
                              px: 0.75,
                              py: 0.2,
                              borderRadius: '4px',
                              bgcolor: alpha(T.accent, 0.08),
                              border: `1px solid ${alpha(T.accent, 0.15)}`,
                            }}
                          >
                            <Typography
                              sx={{
                                fontSize: '0.58rem',
                                color: T.accent,
                                fontWeight: 700,
                                letterSpacing: '0.05em',
                              }}
                            >
                              AUTO
                            </Typography>
                          </Box>
                        </Box>

                        {/* Year / Month — same shared control as the hub view */}
                        <AttendanceFilterDateControls
                          selectedYear={selectedYear}
                          onYearChange={(e) => {
                            setSelectedYear(parseInt(e.target.value));
                            setSelectedMonth(null);
                            setRecords([]);
                            setStartDate('');
                            setEndDate('');
                            setOfficialTimes({});
                            setSnackbar({
                              open: true,
                              message:
                                'Year changed — please click a month to load records.',
                              severity: 'info',
                            });
                          }}
                          yearOptions={yearOptions}
                          selectedMonth={selectedMonth}
                          onMonthClick={handleMonthClick}
                          onMonthClear={() => {
                            setSelectedMonth(null);
                            setRecords([]);
                            setStartDate('');
                            setEndDate('');
                            setOfficialTimes({});
                          }}
                          onQuickDate={handleQuickDateSelect}
                          months={monthsShort}
                        />

                        {/* Show official time checkbox — same boxed style as the hub view */}
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.75,
                            mt: 2,
                            mb: 0.5,
                            px: 1,
                            py: 0.75,
                            borderRadius: '8px',
                            border: `1px solid ${showOfficialTimeOnDtr ? T.accent : T.accentBorder}`,
                            bgcolor: showOfficialTimeOnDtr
                              ? alpha(T.accent, 0.06)
                              : 'transparent',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            '&:hover': {
                              bgcolor: alpha(T.accent, 0.05),
                              border: `1px solid ${T.accent}`,
                            },
                          }}
                          onClick={() => setShowOfficialTimeOnDtr((v) => !v)}
                          className="no-print"
                        >
                          <Checkbox
                            size="small"
                            checked={showOfficialTimeOnDtr}
                            onChange={(e) => {
                              e.stopPropagation();
                              setShowOfficialTimeOnDtr(e.target.checked);
                            }}
                            sx={{
                              p: 0,
                              color: alpha(T.accent, 0.5),
                              '&.Mui-checked': { color: T.accent },
                            }}
                          />
                          <Typography
                            sx={{
                              fontSize: '0.78rem',
                              fontWeight: 600,
                              color: showOfficialTimeOnDtr ? T.accent : T.text,
                              lineHeight: 1.3,
                              userSelect: 'none',
                            }}
                          >
                            Show official time on DTR
                          </Typography>
                        </Box>

                        <Box
                          sx={{
                            mt: 2,
                            mb: 2.5,
                            p: 1.5,
                            borderRadius: 2,
                            bgcolor: T.accentFaint,
                            border: `1px solid ${T.accentBorder}`,
                          }}
                        >
                          <Typography
                            sx={{
                              fontSize: '0.68rem',
                              fontWeight: 700,
                              letterSpacing: '0.08em',
                              textTransform: 'uppercase',
                              color: alpha(T.accent, 0.6),
                              mb: 0.5,
                            }}
                          >
                            Total Records
                          </Typography>
                          <Typography
                            sx={{
                              fontSize: '0.9rem',
                              fontWeight: 800,
                              color: T.text,
                              lineHeight: 1.3,
                            }}
                          >
                            {records.length}{' '}
                            {records.length === 1 ? 'record' : 'records'} found
                          </Typography>
                          <Typography
                            sx={{ fontSize: '0.75rem', color: T.muted, mt: 0.4 }}
                          >
                            {selectedMonth !== null
                              ? `For ${monthsShort[selectedMonth]} ${selectedYear}.`
                              : 'Select a month to load your DTR.'}
                          </Typography>
                        </Box>
                      </Box>
                    </SectionCard>
                  </Grid>

                  {/* RIGHT: DTR preview panel */}
                {/* RIGHT: DTR preview panel */}
  <Grid item xs={12} lg={9}>
    <SectionCard
      sx={{
        ...attendanceMainPanelHeightSx,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
                      {/* Toolbar */}
                      <Box
                        sx={{
                          px: 3.5,
                          py: 2,
                          borderBottom: `1px solid ${T.divider}`,
                          bgcolor: T.accentFaint,
                          flexShrink: 0,
                        }}
                        className="no-print"
                      >
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1.5,
                            }}
                          >
                            <AccessTime sx={{ fontSize: 15, color: T.accent }} />
                            <Typography
                              sx={{
                                fontSize: '0.88rem',
                                fontWeight: 700,
                                color: T.text,
                              }}
                            >
                              DTR Preview
                            </Typography>
                            {selectedMonth !== null && (
                              <Box
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 0.75,
                                }}
                              >
                                <Box
                                  sx={{
                                    width: 4,
                                    height: 4,
                                    borderRadius: '50%',
                                    bgcolor: T.faint,
                                  }}
                                />
                                <Typography
                                  sx={{
                                    fontSize: '0.78rem',
                                    color: T.muted,
                                    fontWeight: 500,
                                  }}
                                >
                                  {employeeName}
                                </Typography>
                                <Box
                                  sx={{
                                    fontSize: '0.65rem',
                                    fontWeight: 700,
                                    color: T.accent,
                                    bgcolor: alpha(T.accent, 0.08),
                                    border: `1px solid ${T.accentBorder}`,
                                    borderRadius: '5px',
                                    px: '6px',
                                    py: '2px',
                                  }}
                                >
                                  {monthsShort[selectedMonth]}
                                </Box>
                              </Box>
                            )}
                          </Box>
                          {selectedMonth !== null && (
                            <Box sx={{ display: 'flex', gap: 1 }}>
                              {/* Legend tooltip */}
                              <Tooltip
                                placement="top"
                                title={
                                  <Box
                                    sx={{
                                      p: 0.5,
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 1,
                                    }}
                                  >
                                    <Typography
                                      variant="caption"
                                      sx={{
                                        fontWeight: 700,
                                        fontSize: '11px',
                                        letterSpacing: '0.05em',
                                      }}
                                    >
                                      LEGEND
                                    </Typography>
                                    {[
                                      {
                                        label: 'Holiday',
                                        bg: 'rgba(237,108,2,0.25)',
                                        border: '#ed6c02',
                                      },
                                      {
                                        label: 'Suspension',
                                        bg: 'rgba(211,47,47,0.2)',
                                        border: '#d32f2f',
                                      },
                                      {
                                        label: 'On Leave',
                                        bg: 'rgba(46,125,50,0.2)',
                                        border: '#2e7d32',
                                      },
                                    ].map(({ label, bg, border }) => (
                                      <Box
                                        key={label}
                                        sx={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 1,
                                        }}
                                      >
                                        <Box
                                          sx={{
                                            width: 28,
                                            height: 16,
                                            backgroundColor: bg,
                                            border: `1.5px solid ${border}`,
                                            borderRadius: '3px',
                                            flexShrink: 0,
                                          }}
                                        />
                                        <Typography
                                          variant="caption"
                                          sx={{
                                            fontSize: '11px',
                                            fontWeight: 500,
                                          }}
                                        >
                                          {label}
                                        </Typography>
                                      </Box>
                                    ))}
                                  </Box>
                                }
                                arrow
                                componentsProps={{
                                  tooltip: {
                                    sx: {
                                      bgcolor: 'white',
                                      color: '#333',
                                      boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                                      border: '1px solid #e0e0e0',
                                      borderRadius: '10px',
                                      p: 1.5,
                                    },
                                  },
                                  arrow: { sx: { color: 'white' } },
                                }}
                              >
                                <AccentButton
                                  variant="contained"
                                  size="small"
                                  aria-label="Color legend"
                                  sx={{
                                    minWidth: 32,
                                    width: 32,
                                    height: 32,
                                    p: 0,
                                    fontSize: '0.85rem',
                                    fontWeight: 800,
                                    bgcolor: T.accent,
                                    color: '#fff',
                                    boxShadow: `0 2px 8px ${alpha(T.accent, 0.3)}`,
                                    '&:hover': { bgcolor: T.accentDark },
                                  }}
                                >
                                  ?
                                </AccentButton>
                              </Tooltip>
                              <Tooltip title="Print DTR" placement="top">
                                <IconButton
                                  size="small"
                                  onClick={printPage}
                                  sx={{
                                    bgcolor: alpha(T.accent, 0.08),
                                    border: `1px solid ${T.accentBorder}`,
                                    color: T.accent,
                                    width: 32,
                                    height: 32,
                                    '&:hover': { bgcolor: alpha(T.accent, 0.15) },
                                  }}
                                >
                                  <PrintIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </Tooltip>
                              <AccentButton
                                variant="contained"
                                size="small"
                                disabled={pdfDownloadLoading}
                                startIcon={
                                  pdfDownloadLoading ? (
                                    <CircularProgress
                                      size={13}
                                      sx={{ color: '#fff' }}
                                    />
                                  ) : (
                                    <PictureAsPdfIcon
                                      sx={{ fontSize: '13px !important' }}
                                    />
                                  )
                                }
                                onClick={downloadPDF}
                                sx={{
                                  fontSize: '0.78rem',
                                  bgcolor: T.accent,
                                  color: '#fff',
                                  boxShadow: `0 2px 8px ${alpha(T.accent, 0.3)}`,
                                  '&:hover': { bgcolor: T.accentDark },
                                }}
                              >
                                {pdfDownloadLoading
                                  ? 'Downloading…'
                                  : 'Download PDF'}
                              </AccentButton>
                            </Box>
                          )}
                        </Box>
                      </Box>

                      {/* Content */}
                      <Box
                        sx={{
                          flexGrow: 1,
                          overflowY: 'auto',
                          position: 'relative',
                          ...scrollbarSx,
                        }}
                      >
                        {selectedMonth === null ? (
                          <Box sx={{ py: 10, textAlign: 'center' }}>
                            <Box
                              sx={{
                                width: 72,
                                height: 72,
                                borderRadius: '50%',
                                bgcolor: T.accentFaint,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                mx: 'auto',
                                mb: 2,
                              }}
                            >
                              <CalendarToday
                                sx={{ fontSize: 32, color: alpha(T.accent, 0.3) }}
                              />
                            </Box>
                            <Typography
                              sx={{
                                fontSize: '0.9rem',
                                fontWeight: 600,
                                color: T.muted,
                                mb: 0.5,
                              }}
                            >
                              Select a DTR Period
                            </Typography>
                            <Typography
                              sx={{ fontSize: '0.78rem', color: T.faint }}
                            >
                              Choose a month from the left panel to view your
                              Daily Time Record.
                            </Typography>
                          </Box>
                        ) : (
                          <Fade in timeout={250}>
                            <Box
                              className="dtr-print-area"
                              sx={{
                                bgcolor: '#f4f0f0',
                                p: 2.5,
                                display: 'flex',
                                justifyContent: 'center',
                                position: 'relative',
                              }}
                            >
                              <Paper
                                elevation={2}
                                sx={{
                                  p: 2,
                                  borderRadius: '8px',
                                  bgcolor: '#fff',
                                  position: 'relative',
                                  boxSizing: 'border-box',
                                  overflowX: 'auto',
                                  width: '100%',
                                }}
                              >
                                <Box sx={{ overflowX: 'auto' }}>
                                  <div className="table-container" ref={dtrRef}>
                                    <div className="table-wrapper">
                                      <DTRTemplate
                                        {...dtrTemplateProps}
                                        keyPrefix="screen"
                                      />
                                    </div>
                                  </div>
                                </Box>
                              </Paper>
                            </Box>
                          </Fade>
                        )}
                      </Box>

                      {/* Footer info bar */}
                      {selectedMonth !== null && (
                        <Box
                          className="no-print"
                          sx={{
                            flexShrink: 0,
                            px: 3.5,
                            py: 1.25,
                            borderTop: `1px solid ${T.divider}`,
                            bgcolor: T.accentFaint,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                          }}
                        >
                          <PictureAsPdfIcon
                            sx={{ fontSize: 13, color: alpha(T.accent, 0.45) }}
                          />
                          <Typography sx={{ fontSize: '0.7rem', color: T.faint }}>
                            Download saves a PDF automatically for{' '}
                            {monthsShort[selectedMonth]} {selectedYear}
                          </Typography>
                        </Box>
                      )}
                    </SectionCard>
                  </Grid>
                </Grid>

              </Box>
            </Box>
          </Fade>
        )}
      </>
    );
  };

  export default DailyTimeRecord;