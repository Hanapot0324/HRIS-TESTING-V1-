import API_BASE_URL from '../../apiConfig';
import { fetchEmployeesByNumber } from '../../utils/employeeLookup';
import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useDeferredValue,
} from 'react';
import axios from 'axios';
import { getAuthHeaders } from '../../utils/auth';
import { useSocket } from '../../contexts/SocketContext';
import {
  Typography,
  TextField,
  Button,
  Box,
  Grid,
  Chip,
  Modal,
  IconButton,
  CircularProgress,
  Snackbar,
  Alert,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  List,
  ListItem,
  Card,
  Fade,
  Divider,
  styled,
  alpha,
  Avatar,
  Tooltip,
  FormControl,
  Select,
  MenuItem,
  TablePagination,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
  Close,
  Search as SearchIcon,
  ViewList as ViewListIcon,
  ViewModule as ViewModuleIcon,
  Person as PersonIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  WorkHistory as WorkHistoryIcon,
  Refresh,
} from '@mui/icons-material';
import ReorderIcon from '@mui/icons-material/Reorder';
import LoadingOverlay from '../LoadingOverlay';
import SuccessfulOverlay from '../SuccessfulOverlay';
import AccessDenied from '../AccessDenied';
import usePageAccess from '../../hooks/usePageAccess';
import DashboardModuleAuditLogs from './DashboardModuleAuditLogs';

// ─── Theme tokens (mirroring Children/EmploymentCategoryManagement) ───────────
const T = {
  accent: '#6d2323',
  accentDark: '#5a1d1d',
  accentMid: '#8B4545',
  accentFaint: 'rgba(109,35,35,0.06)',
  accentBorder: 'rgba(109,35,35,0.14)',
  accentHover: 'rgba(109,35,35,0.10)',
  headerGrad: 'linear-gradient(180deg,#6d2323 0%,#7e2c2c 100%)',
  rowEven: '#ffffff',
  rowOdd: 'rgba(109,35,35,0.025)',
  rowHover: 'rgba(109,35,35,0.055)',
  text: '#1a1a1a',
  muted: '#6b6b6b',
  faint: '#a0a0a0',
  surface: '#ffffff',
  divider: 'rgba(0,0,0,0.08)',
};

// ─── Styled primitives ────────────────────────────────────────────────────────
const SectionCard = styled(Card)({
  borderRadius: 12,
  boxShadow: '0 1px 4px rgba(0,0,0,0.07), 0 4px 24px rgba(0,0,0,0.04)',
  border: '0.5px solid rgba(0,0,0,0.09)',
  overflow: 'hidden',
  background: T.surface,
});

const FieldInput = styled(TextField)({
  '& .MuiOutlinedInput-root': {
    borderRadius: 8,
    fontSize: '0.875rem',
    backgroundColor: '#fff',
    '& fieldset': { borderColor: T.accentBorder },
    '&:hover fieldset': { borderColor: T.accent },
    '&.Mui-focused fieldset': { borderColor: T.accent, borderWidth: 1.5 },
    '& .MuiInputBase-input.Mui-disabled': { WebkitTextFillColor: T.text },
  },
  '& .MuiInputLabel-root.Mui-focused': { color: T.accent },
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

// ─── Shimmer keyframes ────────────────────────────────────────────────────────
const shimmerKeyframes = `
@keyframes weShimmer {
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
}
@keyframes wePulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.60; }
}
`;

const Bone = ({ w = '100%', h = 14, r = 6, sx = {} }) => (
  <Box
    sx={{
      width: w,
      height: h,
      borderRadius: r,
      background: `linear-gradient(90deg, rgba(109,35,35,0.07) 25%, rgba(109,35,35,0.14) 50%, rgba(109,35,35,0.07) 75%)`,
      backgroundSize: '800px 100%',
      animation: 'weShimmer 1.6s infinite linear',
      flexShrink: 0,
      ...sx,
    }}
  />
);

// ─── Section label used inside form panels ────────────────────────────────────
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

// ─── Wireframe skeleton ───────────────────────────────────────────────────────
const WorkExperienceWireframe = () => (
  <>
    <style>{shimmerKeyframes}</style>
    <Box
      sx={{
        py: { xs: 2, md: 4 },
        mt: { xs: 0, md: -5 },
        width: '100vw',
        maxWidth: '100%',
        position: 'relative',
        left: '63%',
        transform: 'translateX(-61%)',
        px: { xs: 2, sm: 3, md: 6 },
      }}
    >
      {/* Header card skeleton */}
      <Box
        sx={{
          mb: 3,
          borderRadius: 3,
          overflow: 'hidden',
          border: `1px solid ${T.accentBorder}`,
          animation: 'wePulse 2s ease-in-out infinite',
        }}
      >
        <Box
          sx={{
            p: 3.5,
            background: 'linear-gradient(135deg,#fdf5f5 0%,#f0dede 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2.5,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              position: 'absolute', top: -50, right: -50,
              width: 180, height: 180, borderRadius: '50%',
              bgcolor: 'rgba(109,35,35,0.06)',
            }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box
              sx={{
                width: 52, height: 52, borderRadius: '50%',
                bgcolor: 'rgba(109,35,35,0.12)', flexShrink: 0,
              }}
            />
            <Box sx={{ flex: 1 }}>
              <Bone w={260} h={18} sx={{ mb: 1 }} />
              <Bone w={400} h={11} />
            </Box>
          </Box>
          <Box sx={{ width: 32, height: 32, borderRadius: '50%', bgcolor: 'rgba(109,35,35,0.1)' }} />
        </Box>
      </Box>

      {/* Two-column skeleton */}
      <Grid container spacing={3}>
        {[0, 1].map((col) => (
          <Grid item xs={12} lg={col === 0 ? 4 : 8} key={col}>
            <Box
              sx={{
                borderRadius: 3,
                border: `1px solid ${T.accentBorder}`,
                bgcolor: '#fff',
                overflow: 'hidden',
                animation: `wePulse 2s ease-in-out ${col * 0.1}s infinite`,
                height: 'calc(100vh - 280px)',
              }}
            >
              <Box
                sx={{
                  px: 3.5, py: 1.25,
                  borderBottom: `1px solid ${T.divider}`,
                  bgcolor: T.accentFaint,
                  display: 'flex', alignItems: 'center', gap: 1.5,
                }}
              >
                <Box sx={{ width: 15, height: 15, borderRadius: '50%', bgcolor: 'rgba(109,35,35,0.12)' }} />
                <Bone w={col === 0 ? 180 : 220} h={13} />
              </Box>
              <Box sx={{ p: 3.5, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                {(col === 0
                  ? [100, 160, 120, 140, 110, 130, 90, 120]
                  : [200, 140, 180, 100, 160]
                ).map((w, i) => (
                  <Box key={i}>
                    <Bone w={w} h={10} sx={{ mb: 1 }} />
                    <Box
                      sx={{
                        height: 40, borderRadius: 2,
                        border: `1px solid ${T.accentBorder}`,
                        bgcolor: '#fafafa',
                      }}
                    />
                  </Box>
                ))}
              </Box>
            </Box>
          </Grid>
        ))}
      </Grid>
    </Box>
  </>
);

// ─── System settings hook (inline) ───────────────────────────────────────────
const useLocalSystemSettings = () => {
  const [settings, setSettings] = useState(() => {
    try {
      const stored = localStorage.getItem('systemSettings');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
    return {
      primaryColor: '#894444',
      secondaryColor: '#6d2323',
      accentColor: '#FEF9E1',
      textColor: '#FFFFFF',
      textPrimaryColor: '#6D2323',
      textSecondaryColor: '#FEF9E1',
      hoverColor: '#6D2323',
      backgroundColor: '#FFFFFF',
    };
  });

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const url = API_BASE_URL.includes('/api')
          ? `${API_BASE_URL}/system-settings`
          : `${API_BASE_URL}/api/system-settings`;
        const response = await axios.get(url);
        if (response.data && typeof response.data === 'object') {
          setSettings(response.data);
          localStorage.setItem('systemSettings', JSON.stringify(response.data));
        }
      } catch (e) {
        console.error('Error fetching system settings:', e);
      }
    };
    fetchSettings();
  }, []);

  return settings;
};

// ─── Employee Autocomplete ────────────────────────────────────────────────────
const buildEmployeeTextField = () =>
  styled(TextField)(() => ({
    '& .MuiOutlinedInput-root': {
      borderRadius: 8,
      fontSize: '0.875rem',
      backgroundColor: '#fff',
      '& fieldset': { borderColor: T.accentBorder },
      '&:hover fieldset': { borderColor: T.accent },
      '&.Mui-focused fieldset': { borderColor: T.accent, borderWidth: 1.5 },
    },
  }));

const EmployeeAutocomplete = ({
  value,
  onChange,
  placeholder = 'Search employee...',
  required = false,
  disabled = false,
  error = false,
  helperText = '',
  selectedEmployee,
  onEmployeeSelect,
  dropdownDisabled = false,
}) => {
  const [query, setQuery] = useState('');
  const [employees, setEmployees] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef(null);
  const dropdownRef = useRef(null);
  const EmpTextField = useMemo(() => buildEmployeeTextField(), []);

  useEffect(() => {
    if (value && !selectedEmployee) fetchEmployeeById(value);
  }, [value]); // eslint-disable-line

  useEffect(() => {
    if (selectedEmployee) setQuery(selectedEmployee.name || '');
    else if (!value) setQuery('');
  }, [selectedEmployee, value]);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target))
        setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchEmployees = async (q) => {
    setIsLoading(true);
    try {
      const r = await axios.get(
        `${API_BASE_URL}/Remittance/employees/search?q=${encodeURIComponent(q)}`,
        getAuthHeaders()
      );
      setEmployees(r.data);
    } catch {
      setEmployees([]);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAllEmployees = async () => {
    setIsLoading(true);
    try {
      const r = await axios.get(
        `${API_BASE_URL}/Remittance/employees/search`,
        getAuthHeaders()
      );
      setEmployees(r.data);
    } catch {
      setEmployees([]);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchEmployeeById = async (empNum) => {
    try {
      const r = await axios.get(
        `${API_BASE_URL}/Remittance/employees/${empNum}`,
        getAuthHeaders()
      );
      onEmployeeSelect(r.data);
      setQuery(r.data.name || '');
    } catch (err) {
      if (err.response?.status !== 404) console.error(err);
    }
  };

  const handleInputChange = (e) => {
    const v = e.target.value;
    setQuery(v);
    setShowDropdown(true);
    if (selectedEmployee && v !== selectedEmployee.name) {
      onEmployeeSelect(null);
      onChange('');
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (v.trim().length >= 2) fetchEmployees(v);
      else if (v.trim().length === 0) fetchAllEmployees();
      else setEmployees([]);
    }, 300);
  };

  return (
    <Box sx={{ position: 'relative', width: '100%' }} ref={dropdownRef}>
      <EmpTextField
        value={query}
        onChange={handleInputChange}
        onFocus={() => {
          setShowDropdown(true);
          if (!employees.length && !isLoading) {
            query.length >= 2 ? fetchEmployees(query) : fetchAllEmployees();
          }
        }}
        onKeyDown={(e) => e.key === 'Escape' && setShowDropdown(false)}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        error={error}
        helperText={helperText}
        fullWidth
        autoComplete="off"
        size="small"
        InputProps={{
          startAdornment: (
            <PersonIcon sx={{ color: T.muted, mr: 1, fontSize: 15 }} />
          ),
          endAdornment: (
            <IconButton
              onClick={
                dropdownDisabled
                  ? undefined
                  : () => {
                      if (!showDropdown) {
                        setShowDropdown(true);
                        if (!employees.length && !isLoading) fetchAllEmployees();
                      } else setShowDropdown(false);
                    }
              }
              size="small"
              disabled={dropdownDisabled}
              sx={{ color: T.muted }}
            >
              {showDropdown ? (
                <ExpandLessIcon sx={{ fontSize: 15 }} />
              ) : (
                <ExpandMoreIcon sx={{ fontSize: 15 }} />
              )}
            </IconButton>
          ),
        }}
      />
      {showDropdown && (
        <Paper
          elevation={4}
          sx={{
            position: 'absolute',
            top: '100%', left: 0, right: 0,
            zIndex: 1300,
            maxHeight: 280,
            overflow: 'auto',
            mt: 0.75,
            borderRadius: 2,
            border: `1px solid ${T.accentBorder}`,
          }}
        >
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', p: 2, gap: 1 }}>
              <CircularProgress size={16} sx={{ color: T.accent }} />
              <Typography variant="body2" sx={{ fontSize: '0.8rem', color: T.muted }}>Loading…</Typography>
            </Box>
          ) : employees.length > 0 ? (
            <List dense disablePadding>
              {employees.map((emp) => (
                <ListItem
                  key={emp.employeeNumber}
                  button
                  onClick={() => {
                    onEmployeeSelect(emp);
                    setQuery(emp.name);
                    setShowDropdown(false);
                    onChange(emp.employeeNumber);
                  }}
                  sx={{
                    py: 1, px: 1.5,
                    '&:hover': { bgcolor: T.accentFaint },
                    borderBottom: `1px solid ${T.divider}`,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Avatar sx={{ width: 28, height: 28, fontSize: '0.72rem', bgcolor: T.accent, color: '#fff', fontWeight: 700 }}>
                      {emp.name?.charAt(0)?.toUpperCase() || '?'}
                    </Avatar>
                    <Box>
                      <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.text }}>{emp.name}</Typography>
                      <Typography sx={{ fontSize: '0.72rem', color: T.muted }}>#{emp.employeeNumber}</Typography>
                    </Box>
                  </Box>
                </ListItem>
              ))}
            </List>
          ) : (
            <Box sx={{ p: 2, textAlign: 'center' }}>
              <Typography sx={{ fontSize: '0.8rem', color: T.faint, fontStyle: 'italic' }}>
                {query.length >= 2 ? `No employees found for "${query}"` : 'Type to search or scroll to browse'}
              </Typography>
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────
const WorkExperience = () => {
  useLocalSystemSettings(); // keeps localStorage in sync
  const { socket, connected } = useSocket();
  const refreshRef = useRef(null);

  // ── State ──
  const [workExperiences, setWorkExperiences] = useState([]);
  const [employeeNames, setEmployeeNames] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearch = useDeferredValue(searchTerm);
  const [newWorkExp, setNewWorkExp] = useState({
    workDateFrom: '',
    workDateTo: '',
    workPositionTitle: '',
    workCompany: '',
    workMonthlySalary: '',
    SalaryJobOrPayGrade: '',
    StatusOfAppointment: '',
    isGovtService: 'No',
    person_id: '',
  });
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [successOpen, setSuccessOpen] = useState(false);
  const [successAction, setSuccessAction] = useState('');
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });
  const [viewMode, setViewMode] = useState('grid');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(24);

  // Modal — split view
  const [modalState, setModalState] = useState({
    open: false,
    employeeId: null,
    employeeName: '',
    workExperiences: [],
  });
  const [selectedWorkExp, setSelectedWorkExp] = useState(null);
  const [tempWorkExpData, setTempWorkExpData] = useState(null);
  const [isEditingWorkExp, setIsEditingWorkExp] = useState(false);

  // Access control
  const { hasAccess } = usePageAccess('workexperience');

  useEffect(() => { setPage(0); }, [deferredSearch]);

  useEffect(() => {
    fetchWorkExperiences().finally(() => setPageLoading(false));
  }, []); // eslint-disable-line

  useEffect(() => { refreshRef.current = fetchWorkExperiences; });

  useEffect(() => {
    if (!socket || !connected) return;
    const handler = () => refreshRef.current?.();
    socket.on('workExperienceTableChanged', handler);
    return () => socket.off('workExperienceTableChanged', handler);
  }, [socket, connected]);

  const showSnackbar = (message, severity = 'success') =>
    setSnackbar({ open: true, message, severity });

  const fetchWorkExperiences = async () => {
    setLoading(true);
    try {
      const r = await axios.get(
        `${API_BASE_URL}/WorkExperienceRoute/work-experience-table`,
        getAuthHeaders()
      );
      setWorkExperiences(r.data);
      const ids = [...new Set(r.data.map((we) => we.person_id).filter(Boolean))];
      const namesMap = {};
      // One bulk lookup instead of a request per employee.
      const found = await fetchEmployeesByNumber(ids);
      ids.forEach((id) => {
        namesMap[id] = found.get(String(id).trim())?.name || 'Unknown';
      });
      setEmployeeNames(namesMap);
    } catch {
      showSnackbar('Failed to fetch work experience records.', 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Grouped & filtered data ──
  const groupedData = useMemo(() => {
    const map = {};
    workExperiences.forEach((we) => {
      if (!map[we.person_id]) {
        map[we.person_id] = {
          employeeId: we.person_id,
          employeeName: employeeNames[we.person_id] || 'Unknown',
          workExperiences: [],
        };
      }
      map[we.person_id].workExperiences.push(we);
    });
    return Object.values(map).map((g) => ({
      ...g,
      workExperiences: g.workExperiences.sort(
        (a, b) => new Date(b.workDateFrom || 0) - new Date(a.workDateFrom || 0)
      ),
    }));
  }, [workExperiences, employeeNames]);

  const filteredData = useMemo(() => {
    const q = (deferredSearch || '').toString().toLowerCase().trim();
    if (!q) return groupedData;
    return groupedData.filter(
      (g) =>
        g.employeeId?.toString().includes(q) ||
        g.employeeName?.toLowerCase().includes(q) ||
        g.workExperiences.some(
          (we) =>
            we.workCompany?.toLowerCase().includes(q) ||
            we.workPositionTitle?.toLowerCase().includes(q)
        )
    );
  }, [groupedData, deferredSearch]);

  const pagedData = useMemo(
    () => filteredData.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [filteredData, page, rowsPerPage]
  );

  // ── CRUD ──
  const validateAdd = () => {
    const errs = {};
    if (!newWorkExp.person_id) errs.person_id = 'Required';
    if (!newWorkExp.workDateFrom) errs.workDateFrom = 'Required';
    if (!newWorkExp.workDateTo) errs.workDateTo = 'Required';
    if (!newWorkExp.workPositionTitle?.trim()) errs.workPositionTitle = 'Required';
    if (!newWorkExp.workCompany?.trim()) errs.workCompany = 'Required';
    if (newWorkExp.workDateFrom && newWorkExp.workDateTo) {
      if (new Date(newWorkExp.workDateFrom) > new Date(newWorkExp.workDateTo))
        errs.workDateTo = 'End date must be after start date';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleCreate = async () => {
    if (!validateAdd()) { showSnackbar('Please fill in all required fields.', 'error'); return; }
    setLoading(true);
    try {
      await axios.post(
        `${API_BASE_URL}/WorkExperienceRoute/work-experience-table`,
        newWorkExp,
        getAuthHeaders()
      );
      setNewWorkExp({
        workDateFrom: '',
        workDateTo: '',
        workPositionTitle: '',
        workCompany: '',
        workMonthlySalary: '',
        SalaryJobOrPayGrade: '',
        StatusOfAppointment: '',
        isGovtService: 'No',
        person_id: '',
      });
      setSelectedEmployee(null);
      setErrors({});
      fetchWorkExperiences();
      setTimeout(() => {
        setLoading(false);
        setSuccessAction('adding');
        setSuccessOpen(true);
        setTimeout(() => setSuccessOpen(false), 2000);
      }, 300);
    } catch (err) {
      showSnackbar(err.response?.data?.error || 'Failed to add work experience record.', 'error');
      setLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!tempWorkExpData) return;
    setLoading(true);
    try {
      await axios.put(
        `${API_BASE_URL}/WorkExperienceRoute/work-experience-table/${tempWorkExpData.id}`,
        tempWorkExpData,
        getAuthHeaders()
      );
      const updatedList = modalState.workExperiences.map((we) =>
        we.id === tempWorkExpData.id ? { ...tempWorkExpData } : we
      );
      setModalState((s) => ({ ...s, workExperiences: updatedList }));
      setSelectedWorkExp({ ...tempWorkExpData });
      setIsEditingWorkExp(false);
      fetchWorkExperiences();
      setSuccessAction('edit');
      setSuccessOpen(true);
      setTimeout(() => setSuccessOpen(false), 2000);
    } catch {
      showSnackbar('Failed to update work experience record.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedWorkExp) return;
    if (!window.confirm('Are you sure you want to delete this work experience record?')) return;
    setLoading(true);
    try {
      await axios.delete(
        `${API_BASE_URL}/WorkExperienceRoute/work-experience-table/${selectedWorkExp.id}`,
        getAuthHeaders()
      );
      const updatedList = modalState.workExperiences.filter((we) => we.id !== selectedWorkExp.id);
      setModalState((s) => ({ ...s, workExperiences: updatedList }));
      if (updatedList.length > 0) selectWorkExp(updatedList[0]);
      else { setSelectedWorkExp(null); setTempWorkExpData(null); }
      fetchWorkExperiences();
      setSuccessAction('delete');
      setSuccessOpen(true);
      setTimeout(() => setSuccessOpen(false), 2000);
    } catch {
      showSnackbar('Failed to delete work experience record.', 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Modal helpers ──
  const openModal = (group) => {
    setModalState({
      open: true,
      employeeId: group.employeeId,
      employeeName: group.employeeName,
      workExperiences: group.workExperiences,
    });
    if (group.workExperiences.length > 0) selectWorkExp(group.workExperiences[0]);
    else { setSelectedWorkExp(null); setTempWorkExpData(null); setIsEditingWorkExp(false); }
  };

  const closeModal = () => {
    setModalState({ open: false, employeeId: null, employeeName: '', workExperiences: [] });
    setSelectedWorkExp(null);
    setTempWorkExpData(null);
    setIsEditingWorkExp(false);
  };

  const selectWorkExp = (we) => {
    setSelectedWorkExp(we);
    setTempWorkExpData({ ...we });
    setIsEditingWorkExp(false);
  };

  const hasChanges = () => {
    if (!tempWorkExpData || !selectedWorkExp) return false;
    return JSON.stringify(tempWorkExpData) !== JSON.stringify(selectedWorkExp);
  };

  const canAdd =
    !loading &&
    !!newWorkExp.person_id &&
    !!newWorkExp.workDateFrom &&
    !!newWorkExp.workDateTo &&
    !!newWorkExp.workPositionTitle?.trim() &&
    !!newWorkExp.workCompany?.trim();

  // ── Access guard ──
  if (hasAccess === false) {
    return (
      <AccessDenied
        title="Access Denied"
        message="You do not have permission to access Work Experience Information."
        returnPath="/admin-home"
        returnButtonText="Return to Home"
      />
    );
  }

  if (pageLoading) return <WorkExperienceWireframe />;

  return (
    <>
      <style>{shimmerKeyframes}</style>
      <Fade in timeout={400}>
        <Box
          sx={{
            py: { xs: 1, md: 2 },
            mt: { xs: 0, md: -2 },
            mb: { xs: 1, md: 2 },
            width: '100vw',
            maxWidth: '100%',
            position: 'relative',
            left: '63%',
            transform: 'translateX(-61%)',
            px: { xs: 2, sm: 3, md: 6 },
          }}
        >
          <LoadingOverlay open={loading} message="Processing work experience record…" />
          <SuccessfulOverlay
            open={successOpen}
            action={successAction}
            onClose={() => setSuccessOpen(false)}
            showOkButton={true}
          />

          {/* ── Page Header ── */}
          <SectionCard sx={{ mb: 2, overflow: 'hidden' }}>
            <Box
              sx={{
                px: 4, py: 3,
                background: 'linear-gradient(135deg, #fdf5f5 0%, #f0dede 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                position: 'relative', overflow: 'hidden',
              }}
            >
              <Box sx={{ position: 'absolute', top: -50, right: -50, width: 200, height: 200, borderRadius: '50%', background: 'radial-gradient(circle, rgba(109,35,35,0.1) 0%, transparent 70%)' }} />
              <Box sx={{ position: 'absolute', bottom: -30, left: '30%', width: 150, height: 150, borderRadius: '50%', background: 'radial-gradient(circle, rgba(109,35,35,0.07) 0%, transparent 70%)' }} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, position: 'relative', zIndex: 1 }}>
                <WorkHistoryIcon sx={{ fontSize: 32, color: T.accent }} />
                <Box>
                  <Typography sx={{ fontSize: '1.25rem', fontWeight: 900, color: T.accent, lineHeight: 1.2, mb: 0.3 }}>
                    Work Experience Information Management
                  </Typography>
                  <Typography sx={{ fontSize: '0.82rem', color: T.accentMid, fontWeight: 700, opacity: 0.9 }}>
                    Administrative Panel • Add and manage work experience records for employees
                  </Typography>
                </Box>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, position: 'relative', zIndex: 1 }}>
                <Box sx={{ px: 2.5, py: 0.75, borderRadius: 6, bgcolor: alpha(T.accent, 0.1), border: `1px solid ${alpha(T.accent, 0.2)}` }}>
                  <Typography sx={{ fontSize: '0.8rem', color: T.accent, fontWeight: 700 }}>
                    {workExperiences.length} {workExperiences.length === 1 ? 'record' : 'records'}
                  </Typography>
                </Box>
                <DashboardModuleAuditLogs tableName="work_experience_table" moduleLabel="Work Experience" />
                <Tooltip title="Refresh Data">
                  <IconButton
                    onClick={fetchWorkExperiences}
                    sx={{ bgcolor: alpha(T.accent, 0.08), color: T.accent, width: 36, height: 36, '&:hover': { bgcolor: alpha(T.accent, 0.15) } }}
                  >
                    <Refresh sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          </SectionCard>

          {/* ── Two-column layout ── */}
          <Grid container spacing={2}>

            {/* ── LEFT: Add New Work Experience ── */}
            <Grid item xs={12} lg={4}>
              <SectionCard sx={{ height: 'calc(100vh - 280px)', display: 'flex', flexDirection: 'column' }}>
                <Box
                  sx={{
                    px: 3.5, py: 1.25,
                    borderBottom: `1px solid ${T.divider}`,
                    display: 'flex', alignItems: 'center', gap: 1.5,
                    bgcolor: T.accentFaint,
                  }}
                >
                  <AddIcon sx={{ fontSize: 15, color: T.accent }} />
                  <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.accent }}>
                    Add New Work Experience
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Typography sx={{ fontSize: '0.72rem', color: T.faint }}>
                    <Box component="span" sx={{ color: '#c62828' }}>*</Box> required
                  </Typography>
                </Box>

                <Box
                  sx={{
                    px: 3.5, py: 3, flexGrow: 1, overflowY: 'auto',
                    display: 'flex', flexDirection: 'column', gap: 0,
                    '&::-webkit-scrollbar': { width: 4 },
                    '&::-webkit-scrollbar-thumb': { bgcolor: T.accentBorder, borderRadius: 2 },
                  }}
                >
                  {/* ── SECTION: Employee ── */}
                  <FormSectionLabel icon={PersonIcon}>Employee</FormSectionLabel>

                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>
                      Search Employee <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <EmployeeAutocomplete
                      value={newWorkExp.person_id}
                      onChange={(val) => {
                        setNewWorkExp((r) => ({ ...r, person_id: val }));
                        setErrors((e) => { const n = { ...e }; delete n.person_id; return n; });
                      }}
                      selectedEmployee={selectedEmployee}
                      onEmployeeSelect={setSelectedEmployee}
                      placeholder="Search name or employee ID…"
                      required
                      error={!!errors.person_id}
                      helperText={errors.person_id || ''}
                    />
                  </Box>

                  {/* Employee preview pill */}
                  {selectedEmployee ? (
                    <Box
                      sx={{
                        display: 'flex', alignItems: 'center', gap: 1.25,
                        px: 1.75, py: 1.25, mb: 2.5, borderRadius: 2,
                        bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}`,
                      }}
                    >
                      <Avatar sx={{ width: 30, height: 30, bgcolor: alpha(T.accent, 0.15), fontSize: '0.78rem', color: T.accent, fontWeight: 700, flexShrink: 0 }}>
                        {selectedEmployee.name?.charAt(0)?.toUpperCase() || '?'}
                      </Avatar>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.text, lineHeight: 1.2 }} noWrap>
                          {selectedEmployee.name}
                        </Typography>
                        <Typography sx={{ fontSize: '0.7rem', color: T.muted }}>
                          #{selectedEmployee.employeeNumber}
                        </Typography>
                      </Box>
                    </Box>
                  ) : (
                    <Box
                      sx={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: `1.5px dashed ${T.accentBorder}`, borderRadius: 2,
                        py: 1.5, mb: 2.5, bgcolor: alpha(T.accent, 0.02),
                      }}
                    >
                      <Typography sx={{ fontSize: '0.75rem', color: T.faint, fontStyle: 'italic' }}>
                        No employee selected yet
                      </Typography>
                    </Box>
                  )}

                  <Divider sx={{ borderColor: T.divider, mb: 2.5 }} />

                  {/* ── SECTION: Work Experience Details ── */}
                  <FormSectionLabel icon={WorkHistoryIcon}>Work Experience Details</FormSectionLabel>

                  {/* Date From */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>
                      Date From <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <FieldInput
                      type="date"
                      value={newWorkExp.workDateFrom}
                      onChange={(e) => {
                        setNewWorkExp((r) => ({ ...r, workDateFrom: e.target.value }));
                        setErrors((er) => { const n = { ...er }; delete n.workDateFrom; return n; });
                      }}
                      fullWidth size="small"
                      InputLabelProps={{ shrink: true }}
                      error={!!errors.workDateFrom}
                      helperText={errors.workDateFrom || ''}
                    />
                  </Box>

                  {/* Date To */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>
                      Date To <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <FieldInput
                      type="date"
                      value={newWorkExp.workDateTo}
                      onChange={(e) => {
                        setNewWorkExp((r) => ({ ...r, workDateTo: e.target.value }));
                        setErrors((er) => { const n = { ...er }; delete n.workDateTo; return n; });
                      }}
                      fullWidth size="small"
                      InputLabelProps={{ shrink: true }}
                      error={!!errors.workDateTo}
                      helperText={errors.workDateTo || ''}
                    />
                  </Box>

                  {/* Position Title */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>
                      Position Title <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <FieldInput
                      value={newWorkExp.workPositionTitle}
                      onChange={(e) => {
                        setNewWorkExp((r) => ({ ...r, workPositionTitle: e.target.value }));
                        setErrors((er) => { const n = { ...er }; delete n.workPositionTitle; return n; });
                      }}
                      fullWidth size="small"
                      error={!!errors.workPositionTitle}
                      helperText={errors.workPositionTitle || ''}
                    />
                  </Box>

                  {/* Company */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>
                      Company / Office <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <FieldInput
                      value={newWorkExp.workCompany}
                      onChange={(e) => {
                        setNewWorkExp((r) => ({ ...r, workCompany: e.target.value }));
                        setErrors((er) => { const n = { ...er }; delete n.workCompany; return n; });
                      }}
                      fullWidth size="small"
                      error={!!errors.workCompany}
                      helperText={errors.workCompany || ''}
                    />
                  </Box>

                  {/* Monthly Salary */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Monthly Salary</Typography>
                    <FieldInput
                      value={newWorkExp.workMonthlySalary}
                      onChange={(e) => setNewWorkExp((r) => ({ ...r, workMonthlySalary: e.target.value }))}
                      fullWidth size="small"
                      placeholder="e.g., 25000"
                    />
                  </Box>

                  {/* Salary Grade */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Salary Job / Pay Grade</Typography>
                    <FieldInput
                      value={newWorkExp.SalaryJobOrPayGrade}
                      onChange={(e) => setNewWorkExp((r) => ({ ...r, SalaryJobOrPayGrade: e.target.value }))}
                      fullWidth size="small"
                      placeholder="e.g., SG-15"
                    />
                  </Box>

                  {/* Status of Appointment */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Status of Appointment</Typography>
                    <FieldInput
                      value={newWorkExp.StatusOfAppointment}
                      onChange={(e) => setNewWorkExp((r) => ({ ...r, StatusOfAppointment: e.target.value }))}
                      fullWidth size="small"
                      placeholder="e.g., Permanent, Casual"
                    />
                  </Box>

                  {/* Government Service */}
                  <Box sx={{ mb: 2 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Government Service?</Typography>
                    <FormControl fullWidth size="small">
                      <Select
                        value={newWorkExp.isGovtService || 'No'}
                        onChange={(e) => setNewWorkExp((r) => ({ ...r, isGovtService: e.target.value }))}
                        sx={{
                          borderRadius: 2, fontSize: '0.875rem',
                          '& .MuiOutlinedInput-notchedOutline': { borderColor: T.accentBorder },
                          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: T.accent },
                          '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: T.accent, borderWidth: 1.5 },
                        }}
                      >
                        <MenuItem value="Yes">Yes</MenuItem>
                        <MenuItem value="No">No</MenuItem>
                      </Select>
                    </FormControl>
                  </Box>

                  {/* Submit */}
                  <Box sx={{ mt: 'auto' }}>
                    {(selectedEmployee || newWorkExp.workPositionTitle) && (
                      <AccentButton
                        onClick={() => {
                          setNewWorkExp({ workDateFrom: '', workDateTo: '', workPositionTitle: '', workCompany: '', workMonthlySalary: '', SalaryJobOrPayGrade: '', StatusOfAppointment: '', isGovtService: 'No', person_id: '' });
                          setSelectedEmployee(null);
                          setErrors({});
                        }}
                        variant="outlined"
                        fullWidth
                        sx={{
                          mb: 1, height: 36, fontSize: '0.8rem',
                          borderColor: T.accentBorder, color: T.muted,
                          '&:hover': { bgcolor: T.accentFaint, borderColor: T.accent, color: T.accent },
                        }}
                      >
                        Clear Form
                      </AccentButton>
                    )}
                    <AccentButton
                      onClick={handleCreate}
                      variant="contained"
                      fullWidth
                      disabled={!canAdd}
                      startIcon={
                        loading
                          ? <CircularProgress size={14} sx={{ color: '#fff' }} />
                          : <AddIcon sx={{ fontSize: '16px !important' }} />
                      }
                      sx={{
                        height: 42,
                        bgcolor: canAdd ? T.accent : '#d0d0d0',
                        color: canAdd ? '#fff' : '#888',
                        boxShadow: canAdd ? `0 2px 10px ${alpha(T.accent, 0.32)}` : 'none',
                        '&:hover': {
                          bgcolor: canAdd ? T.accentDark : '#d0d0d0',
                          boxShadow: canAdd ? `0 4px 16px ${alpha(T.accent, 0.38)}` : 'none',
                        },
                        '&:disabled': { bgcolor: '#d0d0d0 !important', color: '#888 !important', boxShadow: 'none !important', transform: 'none !important' },
                      }}
                    >
                      {loading ? 'Adding…' : 'Add Work Experience Record'}
                    </AccentButton>
                  </Box>
                </Box>
              </SectionCard>
            </Grid>

            {/* ── RIGHT: Records ── */}
            <Grid item xs={12} lg={8}>
              <SectionCard sx={{ height: 'calc(100vh - 280px)', display: 'flex', flexDirection: 'column' }}>
                <Box sx={{ px: 3.5, py: 2, borderBottom: `1px solid ${T.divider}`, bgcolor: T.accentFaint }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <ReorderIcon sx={{ fontSize: 17, color: T.accent }} />
                      <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: T.text }}>
                        Employee Work Experience Records
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <Box sx={{ px: 1.5, py: 0.4, borderRadius: 6, bgcolor: alpha(T.accent, 0.08), border: `1px solid ${alpha(T.accent, 0.15)}` }}>
                        <Typography sx={{ fontSize: '0.72rem', color: T.accent, fontWeight: 700 }}>
                          {filteredData.length} groups
                        </Typography>
                      </Box>
                      <ToggleButtonGroup
                        value={viewMode}
                        exclusive
                        onChange={(_, v) => v && setViewMode(v)}
                        size="small"
                        sx={{
                          '& .MuiToggleButton-root': {
                            px: 1, py: 0.35, border: `1px solid ${T.accentBorder}`, color: T.muted,
                            '&.Mui-selected': { bgcolor: T.accentFaint, color: T.accent },
                          },
                        }}
                      >
                        <ToggleButton value="grid"><ViewModuleIcon sx={{ fontSize: 14 }} /></ToggleButton>
                        <ToggleButton value="list"><ViewListIcon sx={{ fontSize: 14 }} /></ToggleButton>
                      </ToggleButtonGroup>
                    </Box>
                  </Box>
                  <FieldInput
                    size="small"
                    placeholder="Search by employee ID, name, company, or position…"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    fullWidth
                    InputProps={{
                      startAdornment: <SearchIcon sx={{ fontSize: 15, color: T.muted, mr: 0.5 }} />,
                    }}
                  />
                </Box>

                <Box
                  sx={{
                    flexGrow: 1, overflowY: 'auto', p: 2,
                    '&::-webkit-scrollbar': { width: 4 },
                    '&::-webkit-scrollbar-thumb': { bgcolor: T.accentBorder, borderRadius: 2 },
                  }}
                >
                  {pagedData.length === 0 ? (
                    <Box sx={{ py: 10, textAlign: 'center' }}>
                      <Box
                        sx={{
                          width: 72, height: 72, borderRadius: '50%', bgcolor: T.accentFaint,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2,
                        }}
                      >
                        <WorkHistoryIcon sx={{ fontSize: 32, color: alpha(T.accent, 0.3) }} />
                      </Box>
                      <Typography sx={{ fontSize: '0.9rem', fontWeight: 600, color: T.muted, mb: 0.5 }}>
                        {groupedData.length === 0 ? 'No records yet' : 'No records match your search'}
                      </Typography>
                      <Typography sx={{ fontSize: '0.78rem', color: T.faint }}>
                        {groupedData.length === 0
                          ? 'Use the form on the left to add a work experience record.'
                          : 'Try a different search term.'}
                      </Typography>
                    </Box>
                  ) : viewMode === 'grid' ? (
                    <Grid container spacing={1.5} alignItems="stretch">
                      {pagedData.map((group) => (
                        <Grid item xs={12} sm={3} key={group.employeeId} sx={{ display: 'flex' }}>
                          <Box
                            onClick={() => openModal(group)}
                            sx={{
                              width: '100%', display: 'flex', flexDirection: 'column',
                              p: 2, borderRadius: 2, cursor: 'pointer', bgcolor: '#fff',
                              border: `1px solid ${T.accentBorder}`, position: 'relative',
                              transition: 'all 0.13s',
                              '&:hover': {
                                bgcolor: T.rowHover, borderColor: T.accent,
                                transform: 'translateY(-2px)',
                                boxShadow: `0 4px 14px ${alpha(T.accent, 0.12)}`,
                              },
                            }}
                          >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
                              <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: T.accent, flexShrink: 0 }} />
                              <Typography sx={{ fontSize: '0.7rem', color: T.faint }}>#{group.employeeId}</Typography>
                            </Box>
                            <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.text, mb: 1, flexGrow: 1 }} noWrap>
                              {group.employeeName}
                            </Typography>
                            <Chip
                              label={`${group.workExperiences.length} ${group.workExperiences.length === 1 ? 'record' : 'records'}`}
                              size="small"
                              sx={{
                                height: 20, fontSize: '0.7rem', fontWeight: 600,
                                color: T.accent, bgcolor: alpha(T.accent, 0.08),
                                border: `1px solid ${alpha(T.accent, 0.25)}`,
                                borderRadius: '4px', '& .MuiChip-label': { px: 0.75 },
                              }}
                            />
                          </Box>
                        </Grid>
                      ))}
                    </Grid>
                  ) : (
                    <>
                      <Box
                        sx={{
                          px: 1.5, py: 1,
                          display: 'grid', gridTemplateColumns: '110px 1fr 120px',
                          gap: 1, alignItems: 'center',
                          bgcolor: alpha(T.accent, 0.04), borderRadius: 1.5, mb: 1,
                        }}
                      >
                        {['Emp. No', 'Employee', 'Records'].map((col) => (
                          <Typography key={col} sx={{ fontSize: '0.65rem', fontWeight: 700, color: T.accent, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                            {col}
                          </Typography>
                        ))}
                      </Box>
                      {pagedData.map((group, idx) => (
                        <Box
                          key={group.employeeId}
                          onClick={() => openModal(group)}
                          sx={{
                            px: 1.5, py: 1.25,
                            display: 'grid', gridTemplateColumns: '110px 1fr 120px',
                            gap: 1, alignItems: 'center', borderRadius: 1.5,
                            cursor: 'pointer',
                            bgcolor: idx % 2 === 0 ? T.rowEven : T.rowOdd,
                            border: '1px solid transparent',
                            transition: 'background 0.13s ease',
                            '&:hover': { bgcolor: T.rowHover },
                          }}
                        >
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                            <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: T.accent, flexShrink: 0 }} />
                            <Typography sx={{ fontSize: '0.75rem', color: T.muted }}>{group.employeeId}</Typography>
                          </Box>
                          <Typography sx={{ fontSize: '0.82rem', fontWeight: 500, color: T.text }} noWrap>
                            {group.employeeName}
                          </Typography>
                          <Chip
                            label={`${group.workExperiences.length} ${group.workExperiences.length === 1 ? 'record' : 'records'}`}
                            size="small"
                            sx={{
                              height: 20, fontSize: '0.68rem', fontWeight: 600,
                              color: T.accent, bgcolor: alpha(T.accent, 0.08),
                              border: `1px solid ${alpha(T.accent, 0.25)}`,
                              borderRadius: '4px', '& .MuiChip-label': { px: 0.75 },
                            }}
                          />
                        </Box>
                      ))}
                    </>
                  )}
                </Box>

                {filteredData.length > 0 && (
                  <Box sx={{ px: 2, py: 0.5, borderTop: `1px solid ${T.divider}` }}>
                    <TablePagination
                      component="div"
                      count={filteredData.length}
                      page={page}
                      onPageChange={(_, newPage) => setPage(newPage)}
                      rowsPerPage={rowsPerPage}
                      onRowsPerPageChange={(e) => { setRowsPerPage(parseInt(e.target.value, 10)); setPage(0); }}
                      rowsPerPageOptions={[12, 24, 48, 96]}
                      sx={{
                        '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows':
                          { fontSize: '0.78rem', fontWeight: 600 },
                      }}
                    />
                  </Box>
                )}
              </SectionCard>
            </Grid>
          </Grid>

          {/* ── Split-View Modal ── */}
          <Modal
            open={modalState.open}
            onClose={closeModal}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}
          >
            <Fade in={modalState.open}>
              <Box
                sx={{
                  width: '95%', maxWidth: 960, height: '85vh',
                  borderRadius: 3, overflow: 'hidden',
                  boxShadow: '0 24px 64px rgba(0,0,0,0.22)',
                  bgcolor: T.surface, display: 'flex', flexDirection: 'column',
                }}
              >
                {/* Modal header */}
                <Box
                  sx={{
                    px: 3.5, py: 2.5, background: T.headerGrad,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    position: 'relative', overflow: 'hidden', flexShrink: 0,
                  }}
                >
                  <Box sx={{ position: 'absolute', top: -40, right: -30, width: 140, height: 140, borderRadius: '50%', bgcolor: 'rgba(255,255,255,0.04)' }} />
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, position: 'relative', zIndex: 1 }}>
                    <Box sx={{ width: 38, height: 38, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <WorkHistoryIcon sx={{ fontSize: 18, color: '#fff' }} />
                    </Box>
                    <Box>
                      <Typography sx={{ fontWeight: 700, color: '#fff', fontSize: '0.95rem', lineHeight: 1.2, mb: 0.3 }}>
                        Work Experience of {modalState.employeeName}
                      </Typography>
                      <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.68)' }}>
                        Employee #{modalState.employeeId} • {modalState.workExperiences.length}{' '}
                        {modalState.workExperiences.length === 1 ? 'record' : 'records'}
                      </Typography>
                    </Box>
                  </Box>
                  <IconButton
                    onClick={closeModal}
                    size="small"
                    sx={{ color: 'rgba(255,255,255,0.75)', position: 'relative', zIndex: 1, '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' } }}
                  >
                    <Close sx={{ fontSize: 17 }} />
                  </IconButton>
                </Box>

                {/* Split body */}
                <Box sx={{ flexGrow: 1, display: 'flex', overflow: 'hidden' }}>
                  {/* Left panel — record list */}
                  <Box
                    sx={{
                      width: 280, flexShrink: 0,
                      borderRight: `1px solid ${T.divider}`,
                      display: 'flex', flexDirection: 'column',
                      bgcolor: T.accentFaint,
                    }}
                  >
                    <List
                      sx={{
                        flexGrow: 1, overflowY: 'auto', p: 1,
                        '&::-webkit-scrollbar': { width: 4 },
                        '&::-webkit-scrollbar-thumb': { bgcolor: T.accentBorder, borderRadius: 2 },
                      }}
                    >
                      {modalState.workExperiences.map((we) => (
                        <ListItem
                          key={we.id}
                          button
                          selected={selectedWorkExp?.id === we.id}
                          onClick={() => selectWorkExp(we)}
                          sx={{
                            borderRadius: 1.5, mb: 0.75,
                            border: selectedWorkExp?.id === we.id ? `1px solid ${T.accent}` : '1px solid transparent',
                            bgcolor: selectedWorkExp?.id === we.id ? alpha(T.accent, 0.08) : 'transparent',
                            '&.Mui-selected': { bgcolor: alpha(T.accent, 0.08), '&:hover': { bgcolor: alpha(T.accent, 0.13) } },
                            '&:hover': { bgcolor: T.accentFaint },
                          }}
                        >
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, width: '100%' }}>
                            <Avatar sx={{ width: 28, height: 28, bgcolor: alpha(T.accent, 0.15), color: T.accent, fontSize: '0.72rem', fontWeight: 700, flexShrink: 0 }}>
                              {we.workPositionTitle?.charAt(0)?.toUpperCase() || '?'}
                            </Avatar>
                            <Box sx={{ minWidth: 0 }}>
                              <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: T.text, lineHeight: 1.2 }} noWrap>
                                {we.workPositionTitle || 'Untitled Position'}
                              </Typography>
                              <Typography sx={{ fontSize: '0.68rem', color: T.muted }} noWrap>
                                {we.workCompany || 'No Company'}
                              </Typography>
                              <Typography sx={{ fontSize: '0.67rem', color: T.faint }}>
                                {we.workDateFrom?.split('T')[0] || '----'} → {we.workDateTo?.split('T')[0] || '----'}
                              </Typography>
                            </Box>
                          </Box>
                        </ListItem>
                      ))}
                      {modalState.workExperiences.length === 0 && (
                        <Box sx={{ p: 2, textAlign: 'center' }}>
                          <Typography sx={{ fontSize: '0.78rem', color: T.faint, fontStyle: 'italic' }}>
                            No work experience records yet.
                          </Typography>
                        </Box>
                      )}
                    </List>
                  </Box>

                  {/* Right panel — detail / edit */}
                  <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {selectedWorkExp ? (
                      <>
                        <Box
                          sx={{
                            flexGrow: 1, overflowY: 'auto',
                            '&::-webkit-scrollbar': { width: 4 },
                            '&::-webkit-scrollbar-thumb': { bgcolor: T.accentBorder, borderRadius: 2 },
                          }}
                        >
                          {!isEditingWorkExp ? (
                            <>
                              {/* ── Avatar hero ── */}
                              <Box
                                sx={{
                                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                                  py: 4, px: 3,
                                  borderBottom: `1px solid ${T.divider}`,
                                  background: 'linear-gradient(135deg, #fdf5f5 0%, #f0dede 100%)',
                                  position: 'relative',
                                }}
                              >
                                <Box sx={{ position: 'absolute', top: 12, right: 14 }}>
                                  <Chip
                                    label="View mode"
                                    size="small"
                                    sx={{ height: 16, fontSize: '0.62rem', bgcolor: alpha(T.accent, 0.08), color: T.muted, fontWeight: 500 }}
                                  />
                                </Box>
                                <Avatar
                                  sx={{
                                    width: 72, height: 72,
                                    bgcolor: alpha(T.accent, 0.15), color: T.accent,
                                    fontSize: '1.75rem', fontWeight: 700, mb: 1.5,
                                    border: `2px solid ${alpha(T.accent, 0.2)}`,
                                  }}
                                >
                                  {selectedWorkExp.workPositionTitle?.charAt(0)?.toUpperCase() || '?'}
                                </Avatar>
                                <Typography sx={{ fontSize: '1.1rem', fontWeight: 900, color: T.accent, lineHeight: 1.25, textAlign: 'center' }}>
                                  {selectedWorkExp.workPositionTitle || 'Untitled Position'}
                                </Typography>
                                <Typography sx={{ fontSize: '0.78rem', color: T.accentMid, mt: 0.5 }}>
                                  {selectedWorkExp.workCompany || 'No Company'}
                                </Typography>
                              </Box>

                              {/* ── Key-value rows ── */}
                              <Box sx={{ px: 3.5, py: 2.5 }}>
                                {[
                                  { label: 'Date From',             value: selectedWorkExp.workDateFrom?.split('T')[0] || '—' },
                                  { label: 'Date To',               value: selectedWorkExp.workDateTo?.split('T')[0] || '—' },
                                  { label: 'Position Title',        value: selectedWorkExp.workPositionTitle || '—' },
                                  { label: 'Company / Office',      value: selectedWorkExp.workCompany || '—' },
                                  { label: 'Monthly Salary',        value: selectedWorkExp.workMonthlySalary || '—' },
                                  { label: 'Salary / Pay Grade',    value: selectedWorkExp.SalaryJobOrPayGrade || '—' },
                                  { label: 'Status of Appointment', value: selectedWorkExp.StatusOfAppointment || '—' },
                                  { label: 'Government Service',    value: selectedWorkExp.isGovtService || '—' },
                                ].map(({ label, value }, i, arr) => (
                                  <Box
                                    key={label}
                                    sx={{
                                      display: 'flex', alignItems: 'center',
                                      justifyContent: 'space-between',
                                      py: 1.5,
                                      borderBottom: i < arr.length - 1 ? `1px solid ${T.divider}` : 'none',
                                    }}
                                  >
                                    <Typography sx={{ fontSize: '0.78rem', color: T.muted, fontWeight: 600, letterSpacing: '0.03em' }}>
                                      {label}
                                    </Typography>
                                    <Typography
                                      sx={{
                                        fontSize: '0.85rem',
                                        fontWeight: value === '—' ? 400 : 700,
                                        color: value === '—' ? T.faint : T.text,
                                        fontStyle: value === '—' ? 'italic' : 'normal',
                                        textAlign: 'right', maxWidth: '60%',
                                      }}
                                    >
                                      {value}
                                    </Typography>
                                  </Box>
                                ))}
                              </Box>
                            </>
                          ) : (
                            /* ── Edit form ── */
                            <Box sx={{ px: 3.5, py: 3 }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2.5 }}>
                                <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.accent }}>
                                  Edit Work Experience Record
                                </Typography>
                                <Chip
                                  label="Editing"
                                  size="small"
                                  sx={{ height: 16, fontSize: '0.62rem', bgcolor: 'rgba(255,200,0,0.18)', color: '#b8860b', fontWeight: 600 }}
                                />
                              </Box>
                              <Divider sx={{ borderColor: T.divider, mb: 2.5 }} />

                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Date From</Typography>
                                <FieldInput type="date" value={tempWorkExpData?.workDateFrom?.split('T')[0] || ''} onChange={(e) => setTempWorkExpData((r) => ({ ...r, workDateFrom: e.target.value }))} fullWidth size="small" InputLabelProps={{ shrink: true }} />
                              </Box>
                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Date To</Typography>
                                <FieldInput type="date" value={tempWorkExpData?.workDateTo?.split('T')[0] || ''} onChange={(e) => setTempWorkExpData((r) => ({ ...r, workDateTo: e.target.value }))} fullWidth size="small" InputLabelProps={{ shrink: true }} />
                              </Box>
                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Position Title</Typography>
                                <FieldInput value={tempWorkExpData?.workPositionTitle || ''} onChange={(e) => setTempWorkExpData((r) => ({ ...r, workPositionTitle: e.target.value }))} fullWidth size="small" />
                              </Box>
                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Company / Office</Typography>
                                <FieldInput value={tempWorkExpData?.workCompany || ''} onChange={(e) => setTempWorkExpData((r) => ({ ...r, workCompany: e.target.value }))} fullWidth size="small" />
                              </Box>
                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Monthly Salary</Typography>
                                <FieldInput value={tempWorkExpData?.workMonthlySalary || ''} onChange={(e) => setTempWorkExpData((r) => ({ ...r, workMonthlySalary: e.target.value }))} fullWidth size="small" />
                              </Box>
                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Salary / Pay Grade</Typography>
                                <FieldInput value={tempWorkExpData?.SalaryJobOrPayGrade || ''} onChange={(e) => setTempWorkExpData((r) => ({ ...r, SalaryJobOrPayGrade: e.target.value }))} fullWidth size="small" />
                              </Box>
                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Status of Appointment</Typography>
                                <FieldInput value={tempWorkExpData?.StatusOfAppointment || ''} onChange={(e) => setTempWorkExpData((r) => ({ ...r, StatusOfAppointment: e.target.value }))} fullWidth size="small" />
                              </Box>
                              <Box sx={{ mb: 2 }}>
                                <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Government Service?</Typography>
                                <FormControl fullWidth size="small">
                                  <Select
                                    value={tempWorkExpData?.isGovtService || 'No'}
                                    onChange={(e) => setTempWorkExpData((r) => ({ ...r, isGovtService: e.target.value }))}
                                    sx={{
                                      borderRadius: 2, fontSize: '0.875rem',
                                      '& .MuiOutlinedInput-notchedOutline': { borderColor: T.accentBorder },
                                      '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: T.accent },
                                      '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: T.accent, borderWidth: 1.5 },
                                    }}
                                  >
                                    <MenuItem value="Yes">Yes</MenuItem>
                                    <MenuItem value="No">No</MenuItem>
                                  </Select>
                                </FormControl>
                              </Box>
                            </Box>
                          )}
                        </Box>

                        {/* Modal footer */}
                        <Box
                          sx={{
                            px: 3.5, py: 2,
                            borderTop: `1px solid ${T.divider}`,
                            bgcolor: '#f9f9f9',
                            display: 'flex', justifyContent: 'flex-end', gap: 1.25,
                            flexShrink: 0,
                          }}
                        >
                          {!isEditingWorkExp ? (
                            <>
                              <AccentButton
                                onClick={handleDelete}
                                variant="outlined"
                                startIcon={<DeleteIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{
                                  fontSize: '0.8rem', borderColor: '#e57373', color: '#c62828',
                                  '&:hover': { bgcolor: 'rgba(198,40,40,0.04)', borderColor: '#c62828', transform: 'none' },
                                }}
                              >
                                Delete
                              </AccentButton>
                              <AccentButton
                                onClick={() => setIsEditingWorkExp(true)}
                                variant="contained"
                                startIcon={<EditIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{ fontSize: '0.8rem', bgcolor: T.accent, color: '#fff', boxShadow: `0 2px 10px ${alpha(T.accent, 0.32)}`, '&:hover': { bgcolor: T.accentDark } }}
                              >
                                Edit Record
                              </AccentButton>
                            </>
                          ) : (
                            <>
                              <AccentButton
                                onClick={() => { setTempWorkExpData({ ...selectedWorkExp }); setIsEditingWorkExp(false); }}
                                variant="outlined"
                                startIcon={<CancelIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{ fontSize: '0.8rem', borderColor: T.accentBorder, color: T.muted, '&:hover': { bgcolor: T.accentFaint, borderColor: T.accent, color: T.accent } }}
                              >
                                Cancel
                              </AccentButton>
                              <AccentButton
                                onClick={handleUpdate}
                                disabled={!hasChanges()}
                                variant="contained"
                                startIcon={<SaveIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{ fontSize: '0.8rem', bgcolor: T.accent, color: '#fff', boxShadow: `0 2px 10px ${alpha(T.accent, 0.32)}`, '&:hover': { bgcolor: T.accentDark } }}
                              >
                                Save Changes
                              </AccentButton>
                            </>
                          )}
                        </Box>
                      </>
                    ) : (
                      <Box sx={{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 1 }}>
                        <WorkHistoryIcon sx={{ fontSize: 40, color: alpha(T.accent, 0.2) }} />
                        <Typography sx={{ fontSize: '0.88rem', color: T.faint, fontStyle: 'italic' }}>
                          Select a record from the list to view details
                        </Typography>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Box>
            </Fade>
          </Modal>

          <Snackbar
            open={snackbar.open}
            autoHideDuration={3000}
            onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          >
            <Alert onClose={() => setSnackbar((s) => ({ ...s, open: false }))} severity={snackbar.severity} sx={{ width: '100%', borderRadius: 2 }}>
              {snackbar.message}
            </Alert>
          </Snackbar>
        </Box>
      </Fade>
    </>
  );
};

export default WorkExperience;