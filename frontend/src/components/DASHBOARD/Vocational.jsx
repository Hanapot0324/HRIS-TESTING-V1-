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
  Menu,
  MenuItem,
  InputAdornment,
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
  Construction as ConstructionIcon,
  CalendarToday,
  ArrowForward,
  Person as PersonIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  ArrowDropDown as ArrowDropDownIcon,
  Refresh,
} from '@mui/icons-material';
import ReorderIcon from '@mui/icons-material/Reorder';
import LoadingOverlay from '../LoadingOverlay';
import SuccessfulOverlay from '../SuccessfulOverlay';
import AccessDenied from '../AccessDenied';
import usePageAccess from '../../hooks/usePageAccess';
import DashboardModuleAuditLogs from './DashboardModuleAuditLogs';

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

const shimmerKeyframes = `
@keyframes vocationalShimmer {
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
}
@keyframes vocationalPulse {
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
      background:
        'linear-gradient(90deg, rgba(109,35,35,0.07) 25%, rgba(109,35,35,0.14) 50%, rgba(109,35,35,0.07) 75%)',
      backgroundSize: '800px 100%',
      animation: 'vocationalShimmer 1.6s infinite linear',
      flexShrink: 0,
      ...sx,
    }}
  />
);

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

const VocationalWireframe = () => (
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
      <Box
        sx={{
          mb: 3,
          borderRadius: 3,
          overflow: 'hidden',
          border: `1px solid ${T.accentBorder}`,
          animation: 'vocationalPulse 2s ease-in-out infinite',
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
              position: 'absolute',
              top: -50,
              right: -50,
              width: 180,
              height: 180,
              borderRadius: '50%',
              bgcolor: 'rgba(109,35,35,0.06)',
            }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box
              sx={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                bgcolor: 'rgba(109,35,35,0.12)',
                flexShrink: 0,
              }}
            />
            <Box sx={{ flex: 1 }}>
              <Bone w={220} h={18} sx={{ mb: 1 }} />
              <Bone w={360} h={11} />
            </Box>
          </Box>
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              bgcolor: 'rgba(109,35,35,0.1)',
            }}
          />
        </Box>
      </Box>
      <Grid container spacing={3}>
        {[0, 1].map((col) => (
          <Grid item xs={12} lg={col === 0 ? 4 : 8} key={col}>
            <Box
              sx={{
                borderRadius: 3,
                border: `1px solid ${T.accentBorder}`,
                bgcolor: '#fff',
                overflow: 'hidden',
                animation: `vocationalPulse 2s ease-in-out ${col * 0.1}s infinite`,
                height: 'calc(100vh - 280px)',
              }}
            >
              <Box
                sx={{
                  px: 3.5,
                  py: 1.25,
                  borderBottom: `1px solid ${T.divider}`,
                  bgcolor: T.accentFaint,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                }}
              >
                <Box
                  sx={{
                    width: 15,
                    height: 15,
                    borderRadius: '50%',
                    bgcolor: 'rgba(109,35,35,0.12)',
                  }}
                />
                <Bone w={180} h={13} />
              </Box>
              <Box
                sx={{ p: 3.5, display: 'flex', flexDirection: 'column', gap: 2.5 }}
              >
                {[100, 160, 120, 140, 110, 130, 100].map((w, i) => (
                  <Box key={i}>
                    <Bone w={w} h={10} sx={{ mb: 1 }} />
                    <Box
                      sx={{
                        height: 40,
                        borderRadius: 2,
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

const useLocalSystemSettings = () => {
  const [settings, setSettings] = useState(() => {
    try {
      const stored = localStorage.getItem('systemSettings');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {
      // fallback defaults below
    }
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

const FlexibleYearInput = ({
  value,
  onChange,
  label,
  disabled = false,
  error = false,
  helperText = '',
}) => {
  const [anchorEl, setAnchorEl] = useState(null);
  const [inputValue, setInputValue] = useState(value || '');
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let year = 1950; year <= currentYear + 10; year++) years.push(year);

  useEffect(() => {
    setInputValue(value || '');
  }, [value]);

  const handleYearSelect = (year) => {
    setInputValue(year.toString());
    onChange(year.toString());
    setAnchorEl(null);
  };

  const handleInputChange = (e) => {
    const v = e.target.value;
    if (v === '' || (/^\d+$/.test(v) && v.length <= 4)) {
      setInputValue(v);
      onChange(v);
    }
  };

  return (
    <Box>
      <Typography
        sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
      >
        {label}
      </Typography>
      <FieldInput
        value={inputValue}
        onChange={handleInputChange}
        placeholder="Enter year or select..."
        fullWidth
        size="small"
        disabled={disabled}
        error={error}
        helperText={helperText}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                onClick={(e) => setAnchorEl(e.currentTarget)}
                size="small"
                disabled={disabled}
                sx={{ color: T.muted }}
              >
                <ArrowDropDownIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </InputAdornment>
          ),
        }}
      />
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        PaperProps={{ style: { maxHeight: 280, width: 160, borderRadius: 10 } }}
      >
        {years.map((year) => (
          <MenuItem
            key={year}
            onClick={() => handleYearSelect(year)}
            selected={year.toString() === inputValue}
            sx={{
              fontSize: '0.82rem',
              '&.Mui-selected': { bgcolor: T.accentFaint, color: T.accent },
              '&:hover': { bgcolor: T.accentFaint },
            }}
          >
            {year}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
};

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
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedEmployee) setQuery(selectedEmployee.name || '');
    else if (!value) setQuery('');
  }, [selectedEmployee, value]);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
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
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 1300,
            maxHeight: 280,
            overflow: 'auto',
            mt: 0.75,
            borderRadius: 2,
            border: `1px solid ${T.accentBorder}`,
          }}
        >
          {isLoading ? (
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                p: 2,
                gap: 1,
              }}
            >
              <CircularProgress size={16} sx={{ color: T.accent }} />
              <Typography variant="body2" sx={{ fontSize: '0.8rem', color: T.muted }}>
                Loading...
              </Typography>
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
                    py: 1,
                    px: 1.5,
                    '&:hover': { bgcolor: T.accentFaint },
                    borderBottom: `1px solid ${T.divider}`,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Avatar
                      sx={{
                        width: 28,
                        height: 28,
                        fontSize: '0.72rem',
                        bgcolor: T.accent,
                        color: '#fff',
                        fontWeight: 700,
                      }}
                    >
                      {emp.name?.charAt(0)?.toUpperCase() || '?'}
                    </Avatar>
                    <Box>
                      <Typography
                        sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.text }}
                      >
                        {emp.name}
                      </Typography>
                      <Typography sx={{ fontSize: '0.72rem', color: T.muted }}>
                        #{emp.employeeNumber}
                      </Typography>
                    </Box>
                  </Box>
                </ListItem>
              ))}
            </List>
          ) : (
            <Box sx={{ p: 2, textAlign: 'center' }}>
              <Typography
                sx={{ fontSize: '0.8rem', color: T.faint, fontStyle: 'italic' }}
              >
                {query.length >= 2
                  ? `No employees found for "${query}"`
                  : 'Type to search or scroll to browse'}
              </Typography>
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
};

const Vocational = () => {
  useLocalSystemSettings();

  const { socket, connected } = useSocket();
  const refreshRef = useRef(null);

  const [data, setData] = useState([]);
  const [employeeNames, setEmployeeNames] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearch = useDeferredValue(searchTerm);

  const [newVocational, setNewVocational] = useState({
    vocationalNameOfSchool: '',
    vocationalDegree: '',
    vocationalPeriodFrom: '',
    vocationalPeriodTo: '',
    vocationalHighestAttained: '',
    vocationalYearGraduated: '',
    vocationalScholarshipAcademicHonorsReceived: '',
    person_id: '',
  });
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [errors, setErrors] = useState({});

  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [successOpen, setSuccessOpen] = useState(false);
  const [successAction, setSuccessAction] = useState('');
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success',
  });

  const [viewMode, setViewMode] = useState('grid');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(24);

  const [modalState, setModalState] = useState({
    open: false,
    employeeId: null,
    employeeName: '',
    vocationals: [],
  });
  const [selectedVocational, setSelectedVocational] = useState(null);
  const [tempVocationalData, setTempVocationalData] = useState(null);
  const [isEditingVocational, setIsEditingVocational] = useState(false);

  useEffect(() => {
    if (newVocational.vocationalPeriodTo) {
      setNewVocational((prev) => ({
        ...prev,
        vocationalYearGraduated: prev.vocationalPeriodTo,
      }));
    }
  }, [newVocational.vocationalPeriodTo]);

  useEffect(() => {
    if (tempVocationalData?.vocationalPeriodTo) {
      setTempVocationalData((prev) => ({
        ...prev,
        vocationalYearGraduated: prev.vocationalPeriodTo,
      }));
    }
  }, [tempVocationalData?.vocationalPeriodTo]);

  const { hasAccess } = usePageAccess('vocational');

  useEffect(() => {
    setPage(0);
  }, [deferredSearch]);

  useEffect(() => {
    fetchVocational().finally(() => setPageLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshRef.current = fetchVocational;
  });

  useEffect(() => {
    if (!socket || !connected) return;
    const handler = () => refreshRef.current?.();
    socket.on('vocationalChanged', handler);
    return () => socket.off('vocationalChanged', handler);
  }, [socket, connected]);

  const showSnackbar = (message, severity = 'success') =>
    setSnackbar({ open: true, message, severity });

  const fetchVocational = async () => {
    setLoading(true);
    try {
      const r = await axios.get(
        `${API_BASE_URL}/vocational/vocational-table`,
        getAuthHeaders()
      );
      setData(r.data);

      const ids = [...new Set(r.data.map((c) => c.person_id).filter(Boolean))];
      const namesMap = {};
      // One bulk lookup instead of a request per employee.
      const found = await fetchEmployeesByNumber(ids);
      ids.forEach((id) => {
        namesMap[id] = found.get(String(id).trim())?.name || 'Unknown';
      });
      setEmployeeNames(namesMap);
    } catch {
      showSnackbar('Failed to fetch vocational records.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const groupedData = useMemo(() => {
    const map = {};
    data.forEach((v) => {
      if (!map[v.person_id]) {
        map[v.person_id] = {
          employeeId: v.person_id,
          employeeName: employeeNames[v.person_id] || 'Unknown',
          vocationals: [],
        };
      }
      map[v.person_id].vocationals.push(v);
    });
    return Object.values(map);
  }, [data, employeeNames]);

  const filteredData = useMemo(() => {
    const q = (deferredSearch || '').toString().toLowerCase().trim();
    if (!q) return groupedData;
    return groupedData.filter(
      (g) =>
        g.employeeId?.toString().includes(q) ||
        g.employeeName?.toLowerCase().includes(q) ||
        g.vocationals.some(
          (v) =>
            (v.vocationalNameOfSchool || '').toLowerCase().includes(q) ||
            (v.vocationalDegree || '').toLowerCase().includes(q)
        )
    );
  }, [groupedData, deferredSearch]);

  const pagedData = useMemo(
    () => filteredData.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [filteredData, page, rowsPerPage]
  );

  const validateAdd = () => {
    const errs = {};
    if (!newVocational.person_id) errs.person_id = 'Required';
    if (!newVocational.vocationalNameOfSchool?.trim())
      errs.vocationalNameOfSchool = 'Required';
    if (!newVocational.vocationalDegree?.trim()) errs.vocationalDegree = 'Required';

    if (
      newVocational.vocationalPeriodFrom &&
      newVocational.vocationalPeriodTo &&
      parseInt(newVocational.vocationalPeriodFrom, 10) >
        parseInt(newVocational.vocationalPeriodTo, 10)
    ) {
      errs.vocationalPeriodTo = 'Period To must be greater than or equal to Period From';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleCreate = async () => {
    if (!validateAdd()) {
      showSnackbar('Please fill in all required fields.', 'error');
      return;
    }
    setLoading(true);
    try {
      await axios.post(
        `${API_BASE_URL}/vocational/vocational-table`,
        newVocational,
        getAuthHeaders()
      );
      setNewVocational({
        vocationalNameOfSchool: '',
        vocationalDegree: '',
        vocationalPeriodFrom: '',
        vocationalPeriodTo: '',
        vocationalHighestAttained: '',
        vocationalYearGraduated: '',
        vocationalScholarshipAcademicHonorsReceived: '',
        person_id: '',
      });
      setSelectedEmployee(null);
      setErrors({});
      fetchVocational();
      setTimeout(() => {
        setLoading(false);
        setSuccessAction('adding');
        setSuccessOpen(true);
        setTimeout(() => setSuccessOpen(false), 2000);
      }, 300);
    } catch (err) {
      showSnackbar(err.response?.data?.error || 'Failed to add vocational record.', 'error');
      setLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!tempVocationalData) return;

    if (
      tempVocationalData.vocationalPeriodFrom &&
      tempVocationalData.vocationalPeriodTo &&
      parseInt(tempVocationalData.vocationalPeriodFrom, 10) >
        parseInt(tempVocationalData.vocationalPeriodTo, 10)
    ) {
      showSnackbar('Period To must be greater than or equal to Period From.', 'error');
      return;
    }

    setLoading(true);
    try {
      await axios.put(
        `${API_BASE_URL}/vocational/vocational-table/${tempVocationalData.id}`,
        tempVocationalData,
        getAuthHeaders()
      );
      const updatedList = modalState.vocationals.map((v) =>
        v.id === tempVocationalData.id ? { ...tempVocationalData } : v
      );
      setModalState((s) => ({ ...s, vocationals: updatedList }));
      setSelectedVocational({ ...tempVocationalData });
      setIsEditingVocational(false);
      fetchVocational();
      setSuccessAction('edit');
      setSuccessOpen(true);
      setTimeout(() => setSuccessOpen(false), 2000);
    } catch {
      showSnackbar('Failed to update vocational record.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedVocational) return;
    if (!window.confirm('Are you sure you want to delete this vocational record?')) {
      return;
    }

    setLoading(true);
    try {
      await axios.delete(
        `${API_BASE_URL}/vocational/vocational-table/${selectedVocational.id}`,
        getAuthHeaders()
      );
      const updatedList = modalState.vocationals.filter(
        (v) => v.id !== selectedVocational.id
      );
      setModalState((s) => ({ ...s, vocationals: updatedList }));
      if (updatedList.length > 0) selectVocational(updatedList[0]);
      else {
        setSelectedVocational(null);
        setTempVocationalData(null);
      }
      fetchVocational();
      setSuccessAction('delete');
      setSuccessOpen(true);
      setTimeout(() => setSuccessOpen(false), 2000);
    } catch {
      showSnackbar('Failed to delete vocational record.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const openModal = (group) => {
    setModalState({
      open: true,
      employeeId: group.employeeId,
      employeeName: group.employeeName,
      vocationals: group.vocationals,
    });
    if (group.vocationals.length > 0) selectVocational(group.vocationals[0]);
    else {
      setSelectedVocational(null);
      setTempVocationalData(null);
      setIsEditingVocational(false);
    }
  };

  const closeModal = () => {
    setModalState({
      open: false,
      employeeId: null,
      employeeName: '',
      vocationals: [],
    });
    setSelectedVocational(null);
    setTempVocationalData(null);
    setIsEditingVocational(false);
  };

  const selectVocational = (vocational) => {
    setSelectedVocational(vocational);
    setTempVocationalData({ ...vocational });
    setIsEditingVocational(false);
  };

  const hasChanges = () => {
    if (!tempVocationalData || !selectedVocational) return false;
    return JSON.stringify(tempVocationalData) !== JSON.stringify(selectedVocational);
  };

  const canAdd =
    !loading &&
    !!newVocational.person_id &&
    !!newVocational.vocationalNameOfSchool?.trim() &&
    !!newVocational.vocationalDegree?.trim();

  if (hasAccess === false) {
    return (
      <AccessDenied
        title="Access Denied"
        message="You do not have permission to access Vocational Information."
        returnPath="/admin-home"
        returnButtonText="Return to Home"
      />
    );
  }

  if (pageLoading) return <VocationalWireframe />;

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
          <LoadingOverlay open={loading} message="Processing vocational record..." />
          <SuccessfulOverlay
            open={successOpen}
            action={successAction}
            onClose={() => setSuccessOpen(false)}
            showOkButton={true}
          />

          <SectionCard sx={{ mb: 2, overflow: 'hidden' }}>
            <Box
              sx={{
                px: 4,
                py: 3,
                background: 'linear-gradient(135deg, #fdf5f5 0%, #f0dede 100%)',
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
                <ConstructionIcon sx={{ fontSize: 32, color: T.accent }} />
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
                    Vocational Information Management
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: '0.82rem',
                      color: T.accentMid,
                      fontWeight: 700,
                      opacity: 0.9,
                    }}
                  >
                    Administrative Panel • Add and manage vocational records for employees
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
                  <Typography sx={{ fontSize: '0.8rem', color: T.accent, fontWeight: 700 }}>
                    {data.length} {data.length === 1 ? 'record' : 'records'}
                  </Typography>
                </Box>
                <DashboardModuleAuditLogs tableName="vocational_table" moduleLabel="Vocational" />
                <Tooltip title="Refresh Data">
                  <IconButton
                    onClick={fetchVocational}
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

          <Grid container spacing={2}>
            <Grid item xs={12} lg={4}>
              <SectionCard
                sx={{
                  height: 'calc(100vh - 280px)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <Box
                  sx={{
                    px: 3.5,
                    py: 1.25,
                    borderBottom: `1px solid ${T.divider}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    bgcolor: T.accentFaint,
                  }}
                >
                  <AddIcon sx={{ fontSize: 15, color: T.accent }} />
                  <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.accent }}>
                    Add New Vocational
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Typography sx={{ fontSize: '0.72rem', color: T.faint }}>
                    <Box component="span" sx={{ color: '#c62828' }}>
                      *
                    </Box>{' '}
                    required
                  </Typography>
                </Box>

                <Box
                  sx={{
                    px: 3.5,
                    py: 3,
                    flexGrow: 1,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0,
                    '&::-webkit-scrollbar': { width: 4 },
                    '&::-webkit-scrollbar-thumb': {
                      bgcolor: T.accentBorder,
                      borderRadius: 2,
                    },
                  }}
                >
                  <FormSectionLabel icon={PersonIcon}>Employee</FormSectionLabel>

                  <Box sx={{ mb: 2 }}>
                    <Typography
                      sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                    >
                      Search Employee <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <EmployeeAutocomplete
                      value={newVocational.person_id}
                      onChange={(val) => {
                        setNewVocational((r) => ({ ...r, person_id: val }));
                        setErrors((e) => {
                          const n = { ...e };
                          delete n.person_id;
                          return n;
                        });
                      }}
                      selectedEmployee={selectedEmployee}
                      onEmployeeSelect={setSelectedEmployee}
                      placeholder="Search name or employee ID..."
                      required
                      error={!!errors.person_id}
                      helperText={errors.person_id || ''}
                    />
                  </Box>

                  {selectedEmployee ? (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.25,
                        px: 1.75,
                        py: 1.25,
                        mb: 2.5,
                        borderRadius: 2,
                        bgcolor: T.accentFaint,
                        border: `1px solid ${T.accentBorder}`,
                      }}
                    >
                      <Avatar
                        sx={{
                          width: 30,
                          height: 30,
                          bgcolor: alpha(T.accent, 0.15),
                          fontSize: '0.78rem',
                          color: T.accent,
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        {selectedEmployee.name?.charAt(0)?.toUpperCase() || '?'}
                      </Avatar>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          sx={{
                            fontSize: '0.82rem',
                            fontWeight: 700,
                            color: T.text,
                            lineHeight: 1.2,
                          }}
                          noWrap
                        >
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
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1.5px dashed ${T.accentBorder}`,
                        borderRadius: 2,
                        py: 1.5,
                        mb: 2.5,
                        bgcolor: alpha(T.accent, 0.02),
                      }}
                    >
                      <Typography
                        sx={{ fontSize: '0.75rem', color: T.faint, fontStyle: 'italic' }}
                      >
                        No employee selected yet
                      </Typography>
                    </Box>
                  )}

                  <Divider sx={{ borderColor: T.divider, mb: 2.5 }} />

                  <FormSectionLabel icon={ConstructionIcon}>
                    Vocational Details
                  </FormSectionLabel>

                  <Box sx={{ mb: 2 }}>
                    <Typography
                      sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                    >
                      School Name <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <FieldInput
                      value={newVocational.vocationalNameOfSchool}
                      onChange={(e) => {
                        setNewVocational((r) => ({
                          ...r,
                          vocationalNameOfSchool: e.target.value,
                        }));
                        setErrors((er) => {
                          const n = { ...er };
                          delete n.vocationalNameOfSchool;
                          return n;
                        });
                      }}
                      fullWidth
                      size="small"
                      error={!!errors.vocationalNameOfSchool}
                      helperText={errors.vocationalNameOfSchool || ''}
                    />
                  </Box>

                  <Box sx={{ mb: 2 }}>
                    <Typography
                      sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                    >
                      Degree <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <FieldInput
                      value={newVocational.vocationalDegree}
                      onChange={(e) => {
                        setNewVocational((r) => ({
                          ...r,
                          vocationalDegree: e.target.value,
                        }));
                        setErrors((er) => {
                          const n = { ...er };
                          delete n.vocationalDegree;
                          return n;
                        });
                      }}
                      fullWidth
                      size="small"
                      error={!!errors.vocationalDegree}
                      helperText={errors.vocationalDegree || ''}
                    />
                  </Box>

                  <Box sx={{ mb: 2 }}>
                    <FlexibleYearInput
                      value={newVocational.vocationalPeriodFrom}
                      onChange={(val) =>
                        setNewVocational((r) => ({ ...r, vocationalPeriodFrom: val }))
                      }
                      label="Period From"
                    />
                  </Box>

                  <Box sx={{ mb: 2 }}>
                    <FlexibleYearInput
                      value={newVocational.vocationalPeriodTo}
                      onChange={(val) => {
                        setNewVocational((r) => ({ ...r, vocationalPeriodTo: val }));
                        setErrors((er) => {
                          const n = { ...er };
                          delete n.vocationalPeriodTo;
                          return n;
                        });
                      }}
                      label="Period To"
                      error={!!errors.vocationalPeriodTo}
                      helperText={errors.vocationalPeriodTo || ''}
                    />
                  </Box>

                  <Box sx={{ mb: 2 }}>
                    <Typography
                      sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                    >
                      Highest Attained
                    </Typography>
                    <FieldInput
                      value={newVocational.vocationalHighestAttained}
                      onChange={(e) =>
                        setNewVocational((r) => ({
                          ...r,
                          vocationalHighestAttained: e.target.value,
                        }))
                      }
                      fullWidth
                      size="small"
                    />
                  </Box>

                  <Box sx={{ mb: 2 }}>
                    <Typography
                      sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                    >
                      Year Graduated{' '}
                      <Box component="span" sx={{ fontSize: '0.68rem', color: T.faint, fontWeight: 400 }}>
                        (auto-filled)
                      </Box>
                    </Typography>
                    <Box
                      sx={{
                        p: 1.5,
                        bgcolor: T.accentFaint,
                        borderRadius: 2,
                        border: `1px solid ${T.accentBorder}`,
                      }}
                    >
                      <Typography sx={{ fontSize: '0.82rem', color: T.muted }}>
                        {newVocational.vocationalYearGraduated || '-'}
                      </Typography>
                    </Box>
                  </Box>

                  <Box sx={{ mb: 2 }}>
                    <Typography
                      sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                    >
                      Honors Received
                    </Typography>
                    <FieldInput
                      value={newVocational.vocationalScholarshipAcademicHonorsReceived}
                      onChange={(e) =>
                        setNewVocational((r) => ({
                          ...r,
                          vocationalScholarshipAcademicHonorsReceived: e.target.value,
                        }))
                      }
                      fullWidth
                      size="small"
                    />
                  </Box>

                  <Box sx={{ mt: 'auto' }}>
                    {(selectedEmployee || newVocational.vocationalNameOfSchool) && (
                      <AccentButton
                        onClick={() => {
                          setNewVocational({
                            vocationalNameOfSchool: '',
                            vocationalDegree: '',
                            vocationalPeriodFrom: '',
                            vocationalPeriodTo: '',
                            vocationalHighestAttained: '',
                            vocationalYearGraduated: '',
                            vocationalScholarshipAcademicHonorsReceived: '',
                            person_id: '',
                          });
                          setSelectedEmployee(null);
                          setErrors({});
                        }}
                        variant="outlined"
                        fullWidth
                        sx={{
                          mb: 1,
                          height: 36,
                          fontSize: '0.8rem',
                          borderColor: T.accentBorder,
                          color: T.muted,
                          '&:hover': {
                            bgcolor: T.accentFaint,
                            borderColor: T.accent,
                            color: T.accent,
                          },
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
                        loading ? (
                          <CircularProgress size={14} sx={{ color: '#fff' }} />
                        ) : (
                          <AddIcon sx={{ fontSize: '16px !important' }} />
                        )
                      }
                      sx={{
                        height: 42,
                        bgcolor: canAdd ? T.accent : '#d0d0d0',
                        color: canAdd ? '#fff' : '#888',
                        boxShadow: canAdd ? `0 2px 10px ${alpha(T.accent, 0.32)}` : 'none',
                        '&:hover': {
                          bgcolor: canAdd ? T.accentDark : '#d0d0d0',
                          boxShadow: canAdd
                            ? `0 4px 16px ${alpha(T.accent, 0.38)}`
                            : 'none',
                        },
                        '&:disabled': {
                          bgcolor: '#d0d0d0 !important',
                          color: '#888 !important',
                          boxShadow: 'none !important',
                          transform: 'none !important',
                        },
                      }}
                    >
                      {loading ? 'Adding...' : 'Add Vocational Record'}
                    </AccentButton>
                  </Box>
                </Box>
              </SectionCard>
            </Grid>

            <Grid item xs={12} lg={8}>
              <SectionCard
                sx={{
                  height: 'calc(100vh - 280px)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <Box
                  sx={{
                    px: 3.5,
                    py: 2,
                    borderBottom: `1px solid ${T.divider}`,
                    bgcolor: T.accentFaint,
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      mb: 1.5,
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <ReorderIcon sx={{ fontSize: 17, color: T.accent }} />
                      <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: T.text }}>
                        Employee Vocational Records
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <Box
                        sx={{
                          px: 1.5,
                          py: 0.4,
                          borderRadius: 6,
                          bgcolor: alpha(T.accent, 0.08),
                          border: `1px solid ${alpha(T.accent, 0.15)}`,
                        }}
                      >
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
                            px: 1,
                            py: 0.35,
                            border: `1px solid ${T.accentBorder}`,
                            color: T.muted,
                            '&.Mui-selected': { bgcolor: T.accentFaint, color: T.accent },
                          },
                        }}
                      >
                        <ToggleButton value="grid">
                          <ViewModuleIcon sx={{ fontSize: 14 }} />
                        </ToggleButton>
                        <ToggleButton value="list">
                          <ViewListIcon sx={{ fontSize: 14 }} />
                        </ToggleButton>
                      </ToggleButtonGroup>
                    </Box>
                  </Box>

                  <FieldInput
                    size="small"
                    placeholder="Search by employee ID, name, school, or degree..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    fullWidth
                    InputProps={{
                      startAdornment: (
                        <SearchIcon sx={{ fontSize: 15, color: T.muted, mr: 0.5 }} />
                      ),
                    }}
                  />
                </Box>

                <Box
                  sx={{
                    flexGrow: 1,
                    overflowY: 'auto',
                    p: 2,
                    '&::-webkit-scrollbar': { width: 4 },
                    '&::-webkit-scrollbar-thumb': {
                      bgcolor: T.accentBorder,
                      borderRadius: 2,
                    },
                  }}
                >
                  {pagedData.length === 0 ? (
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
                        <ConstructionIcon
                          sx={{ fontSize: 32, color: alpha(T.accent, 0.3) }}
                        />
                      </Box>
                      <Typography
                        sx={{ fontSize: '0.9rem', fontWeight: 600, color: T.muted, mb: 0.5 }}
                      >
                        {groupedData.length === 0
                          ? 'No records yet'
                          : 'No records match your search'}
                      </Typography>
                      <Typography sx={{ fontSize: '0.78rem', color: T.faint }}>
                        {groupedData.length === 0
                          ? 'Use the form on the left to add a vocational record.'
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
                              width: '100%',
                              display: 'flex',
                              flexDirection: 'column',
                              p: 2,
                              borderRadius: 2,
                              cursor: 'pointer',
                              bgcolor: '#fff',
                              border: `1px solid ${T.accentBorder}`,
                              position: 'relative',
                              transition: 'all 0.13s',
                              '&:hover': {
                                bgcolor: T.rowHover,
                                borderColor: T.accent,
                                transform: 'translateY(-2px)',
                                boxShadow: `0 4px 14px ${alpha(T.accent, 0.12)}`,
                              },
                            }}
                          >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
                              <Box
                                sx={{
                                  width: 6,
                                  height: 6,
                                  borderRadius: '50%',
                                  bgcolor: T.accent,
                                  flexShrink: 0,
                                }}
                              />
                              <Typography sx={{ fontSize: '0.7rem', color: T.faint }}>
                                #{group.employeeId}
                              </Typography>
                            </Box>
                            <Typography
                              sx={{
                                fontSize: '0.82rem',
                                fontWeight: 700,
                                color: T.text,
                                mb: 1,
                                flexGrow: 1,
                              }}
                              noWrap
                            >
                              {group.employeeName}
                            </Typography>
                            <Chip
                              label={`${group.vocationals.length} ${
                                group.vocationals.length === 1 ? 'record' : 'records'
                              }`}
                              size="small"
                              sx={{
                                height: 20,
                                fontSize: '0.7rem',
                                fontWeight: 600,
                                color: T.accent,
                                bgcolor: alpha(T.accent, 0.08),
                                border: `1px solid ${alpha(T.accent, 0.25)}`,
                                borderRadius: '4px',
                                '& .MuiChip-label': { px: 0.75 },
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
                          px: 1.5,
                          py: 1,
                          display: 'grid',
                          gridTemplateColumns: '110px 1fr 120px',
                          gap: 1,
                          alignItems: 'center',
                          bgcolor: alpha(T.accent, 0.04),
                          borderRadius: 1.5,
                          mb: 1,
                        }}
                      >
                        {['Emp. No', 'Employee', 'Records'].map((col) => (
                          <Typography
                            key={col}
                            sx={{
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              color: T.accent,
                              textTransform: 'uppercase',
                              letterSpacing: '0.07em',
                            }}
                          >
                            {col}
                          </Typography>
                        ))}
                      </Box>
                      {pagedData.map((group, idx) => (
                        <Box
                          key={group.employeeId}
                          onClick={() => openModal(group)}
                          sx={{
                            px: 1.5,
                            py: 1.25,
                            display: 'grid',
                            gridTemplateColumns: '110px 1fr 120px',
                            gap: 1,
                            alignItems: 'center',
                            borderRadius: 1.5,
                            cursor: 'pointer',
                            bgcolor: idx % 2 === 0 ? T.rowEven : T.rowOdd,
                            border: '1px solid transparent',
                            transition: 'background 0.13s ease',
                            '&:hover': { bgcolor: T.rowHover },
                          }}
                        >
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                            <Box
                              sx={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                bgcolor: T.accent,
                                flexShrink: 0,
                              }}
                            />
                            <Typography sx={{ fontSize: '0.75rem', color: T.muted }}>
                              {group.employeeId}
                            </Typography>
                          </Box>
                          <Typography
                            sx={{ fontSize: '0.82rem', fontWeight: 500, color: T.text }}
                            noWrap
                          >
                            {group.employeeName}
                          </Typography>
                          <Chip
                            label={`${group.vocationals.length} ${
                              group.vocationals.length === 1 ? 'record' : 'records'
                            }`}
                            size="small"
                            sx={{
                              height: 20,
                              fontSize: '0.68rem',
                              fontWeight: 600,
                              color: T.accent,
                              bgcolor: alpha(T.accent, 0.08),
                              border: `1px solid ${alpha(T.accent, 0.25)}`,
                              borderRadius: '4px',
                              '& .MuiChip-label': { px: 0.75 },
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
                      onRowsPerPageChange={(e) => {
                        setRowsPerPage(parseInt(e.target.value, 10));
                        setPage(0);
                      }}
                      rowsPerPageOptions={[12, 24, 48, 96]}
                      sx={{
                        '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
                          fontSize: '0.78rem',
                          fontWeight: 600,
                        },
                      }}
                    />
                  </Box>
                )}
              </SectionCard>
            </Grid>
          </Grid>

          <Modal
            open={modalState.open}
            onClose={closeModal}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}
          >
            <Fade in={modalState.open}>
              <Box
                sx={{
                  width: '95%',
                  maxWidth: 900,
                  height: '85vh',
                  borderRadius: 3,
                  overflow: 'hidden',
                  boxShadow: '0 24px 64px rgba(0,0,0,0.22)',
                  bgcolor: T.surface,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <Box
                  sx={{
                    px: 3.5,
                    py: 2.5,
                    background: T.headerGrad,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    position: 'relative',
                    overflow: 'hidden',
                    flexShrink: 0,
                  }}
                >
                  <Box
                    sx={{
                      position: 'absolute',
                      top: -40,
                      right: -30,
                      width: 140,
                      height: 140,
                      borderRadius: '50%',
                      bgcolor: 'rgba(255,255,255,0.04)',
                    }}
                  />
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 2,
                      position: 'relative',
                      zIndex: 1,
                    }}
                  >
                    <Box
                      sx={{
                        width: 38,
                        height: 38,
                        borderRadius: 2,
                        bgcolor: 'rgba(255,255,255,0.15)',
                        border: '1px solid rgba(255,255,255,0.2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <ConstructionIcon sx={{ fontSize: 18, color: '#fff' }} />
                    </Box>
                    <Box>
                      <Typography
                        sx={{
                          fontWeight: 700,
                          color: '#fff',
                          fontSize: '0.95rem',
                          lineHeight: 1.2,
                          mb: 0.3,
                        }}
                      >
                        Vocational Records of {modalState.employeeName}
                      </Typography>
                      <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.68)' }}>
                        Employee #{modalState.employeeId} • {modalState.vocationals.length}{' '}
                        {modalState.vocationals.length === 1 ? 'record' : 'records'}
                      </Typography>
                    </Box>
                  </Box>
                  <IconButton
                    onClick={closeModal}
                    size="small"
                    sx={{
                      color: 'rgba(255,255,255,0.75)',
                      position: 'relative',
                      zIndex: 1,
                      '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' },
                    }}
                  >
                    <Close sx={{ fontSize: 17 }} />
                  </IconButton>
                </Box>

                <Box sx={{ flexGrow: 1, display: 'flex', overflow: 'hidden' }}>
                  <Box
                    sx={{
                      width: 280,
                      flexShrink: 0,
                      borderRight: `1px solid ${T.divider}`,
                      display: 'flex',
                      flexDirection: 'column',
                      bgcolor: T.accentFaint,
                    }}
                  >
                    <List
                      sx={{
                        flexGrow: 1,
                        overflowY: 'auto',
                        p: 1,
                        '&::-webkit-scrollbar': { width: 4 },
                        '&::-webkit-scrollbar-thumb': {
                          bgcolor: T.accentBorder,
                          borderRadius: 2,
                        },
                      }}
                    >
                      {modalState.vocationals.map((vocational) => (
                        <ListItem
                          key={vocational.id}
                          button
                          selected={selectedVocational?.id === vocational.id}
                          onClick={() => selectVocational(vocational)}
                          sx={{
                            borderRadius: 1.5,
                            mb: 0.75,
                            border:
                              selectedVocational?.id === vocational.id
                                ? `1px solid ${T.accent}`
                                : '1px solid transparent',
                            bgcolor:
                              selectedVocational?.id === vocational.id
                                ? alpha(T.accent, 0.08)
                                : 'transparent',
                            '&.Mui-selected': {
                              bgcolor: alpha(T.accent, 0.08),
                              '&:hover': { bgcolor: alpha(T.accent, 0.13) },
                            },
                            '&:hover': { bgcolor: T.accentFaint },
                          }}
                        >
                          <Box
                            sx={{ display: 'flex', alignItems: 'center', gap: 1.25, width: '100%' }}
                          >
                            <Avatar
                              sx={{
                                width: 28,
                                height: 28,
                                bgcolor: alpha(T.accent, 0.15),
                                color: T.accent,
                                fontSize: '0.72rem',
                                fontWeight: 700,
                                flexShrink: 0,
                              }}
                            >
                              {vocational.vocationalNameOfSchool
                                ?.charAt(0)
                                ?.toUpperCase() || '?'}
                            </Avatar>
                            <Box sx={{ minWidth: 0 }}>
                              <Typography
                                sx={{ fontSize: '0.8rem', fontWeight: 700, color: T.text, lineHeight: 1.2 }}
                                noWrap
                              >
                                {vocational.vocationalNameOfSchool || 'Unnamed'}
                              </Typography>
                              <Typography sx={{ fontSize: '0.68rem', color: T.muted }} noWrap>
                                {vocational.vocationalDegree || '-'}
                              </Typography>
                            </Box>
                          </Box>
                        </ListItem>
                      ))}
                      {modalState.vocationals.length === 0 && (
                        <Box sx={{ p: 2, textAlign: 'center' }}>
                          <Typography
                            sx={{ fontSize: '0.78rem', color: T.faint, fontStyle: 'italic' }}
                          >
                            No vocational records yet.
                          </Typography>
                        </Box>
                      )}
                    </List>
                  </Box>

                  <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {selectedVocational ? (
                      <>
                        <Box
                          sx={{
                            flexGrow: 1,
                            overflowY: 'auto',
                            '&::-webkit-scrollbar': { width: 4 },
                            '&::-webkit-scrollbar-thumb': {
                              bgcolor: T.accentBorder,
                              borderRadius: 2,
                            },
                          }}
                        >
                          {!isEditingVocational ? (
                            <>
                              <Box
                                sx={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  py: 4,
                                  px: 3,
                                  borderBottom: `1px solid ${T.divider}`,
                                  background:
                                    'linear-gradient(135deg, #fdf5f5 0%, #f0dede 100%)',
                                  position: 'relative',
                                }}
                              >
                                <Box sx={{ position: 'absolute', top: 12, right: 14 }}>
                                  <Chip
                                    label="View mode"
                                    size="small"
                                    sx={{
                                      height: 16,
                                      fontSize: '0.62rem',
                                      bgcolor: alpha(T.accent, 0.08),
                                      color: T.muted,
                                      fontWeight: 500,
                                    }}
                                  />
                                </Box>
                                <Avatar
                                  sx={{
                                    width: 72,
                                    height: 72,
                                    bgcolor: alpha(T.accent, 0.15),
                                    color: T.accent,
                                    fontSize: '1.75rem',
                                    fontWeight: 700,
                                    mb: 1.5,
                                    border: `2px solid ${alpha(T.accent, 0.2)}`,
                                  }}
                                >
                                  {selectedVocational.vocationalNameOfSchool
                                    ?.charAt(0)
                                    ?.toUpperCase() || '?'}
                                </Avatar>
                                <Typography
                                  sx={{
                                    fontSize: '1.1rem',
                                    fontWeight: 900,
                                    color: T.accent,
                                    lineHeight: 1.25,
                                    textAlign: 'center',
                                  }}
                                >
                                  {selectedVocational.vocationalNameOfSchool ||
                                    'Unnamed School'}
                                </Typography>
                                <Typography
                                  sx={{ fontSize: '0.78rem', color: T.accentMid, mt: 0.5 }}
                                >
                                  {selectedVocational.vocationalDegree || '-'}
                                </Typography>
                              </Box>

                              <Box sx={{ px: 3.5, py: 2.5 }}>
                                {[
                                  {
                                    label: 'School Name',
                                    value: selectedVocational.vocationalNameOfSchool,
                                  },
                                  {
                                    label: 'Degree',
                                    value: selectedVocational.vocationalDegree || '-',
                                  },
                                  {
                                    label: 'Period From',
                                    value: selectedVocational.vocationalPeriodFrom || '-',
                                  },
                                  {
                                    label: 'Period To',
                                    value: selectedVocational.vocationalPeriodTo || '-',
                                  },
                                  {
                                    label: 'Highest Attained',
                                    value:
                                      selectedVocational.vocationalHighestAttained || '-',
                                  },
                                  {
                                    label: 'Year Graduated',
                                    value:
                                      selectedVocational.vocationalYearGraduated || '-',
                                  },
                                  {
                                    label: 'Honors Received',
                                    value:
                                      selectedVocational.vocationalScholarshipAcademicHonorsReceived ||
                                      '-',
                                  },
                                ].map(({ label, value }, i, arr) => (
                                  <Box
                                    key={label}
                                    sx={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      py: 1.5,
                                      borderBottom:
                                        i < arr.length - 1
                                          ? `1px solid ${T.divider}`
                                          : 'none',
                                    }}
                                  >
                                    <Typography
                                      sx={{
                                        fontSize: '0.78rem',
                                        color: T.muted,
                                        fontWeight: 600,
                                        letterSpacing: '0.03em',
                                      }}
                                    >
                                      {label}
                                    </Typography>
                                    <Typography
                                      sx={{
                                        fontSize: '0.85rem',
                                        fontWeight: value === '-' ? 400 : 700,
                                        color: value === '-' ? T.faint : T.text,
                                        fontStyle: value === '-' ? 'italic' : 'normal',
                                        textAlign: 'right',
                                        maxWidth: '60%',
                                      }}
                                    >
                                      {value}
                                    </Typography>
                                  </Box>
                                ))}
                              </Box>
                            </>
                          ) : (
                            <Box sx={{ px: 3.5, py: 3 }}>
                              <Box
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  mb: 2.5,
                                }}
                              >
                                <Typography
                                  sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.accent }}
                                >
                                  Edit Vocational Record
                                </Typography>
                                <Chip
                                  label="Editing"
                                  size="small"
                                  sx={{
                                    height: 16,
                                    fontSize: '0.62rem',
                                    bgcolor: 'rgba(255,200,0,0.18)',
                                    color: '#b8860b',
                                    fontWeight: 600,
                                  }}
                                />
                              </Box>
                              <Divider sx={{ borderColor: T.divider, mb: 2.5 }} />

                              <Box sx={{ mb: 2 }}>
                                <Typography
                                  sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                                >
                                  School Name
                                </Typography>
                                <FieldInput
                                  value={tempVocationalData.vocationalNameOfSchool}
                                  onChange={(e) =>
                                    setTempVocationalData((r) => ({
                                      ...r,
                                      vocationalNameOfSchool: e.target.value,
                                    }))
                                  }
                                  fullWidth
                                  size="small"
                                />
                              </Box>

                              <Box sx={{ mb: 2 }}>
                                <Typography
                                  sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                                >
                                  Degree
                                </Typography>
                                <FieldInput
                                  value={tempVocationalData.vocationalDegree}
                                  onChange={(e) =>
                                    setTempVocationalData((r) => ({
                                      ...r,
                                      vocationalDegree: e.target.value,
                                    }))
                                  }
                                  fullWidth
                                  size="small"
                                />
                              </Box>

                              <Box sx={{ mb: 2 }}>
                                <FlexibleYearInput
                                  value={tempVocationalData.vocationalPeriodFrom}
                                  onChange={(val) =>
                                    setTempVocationalData((r) => ({
                                      ...r,
                                      vocationalPeriodFrom: val,
                                    }))
                                  }
                                  label="Period From"
                                />
                              </Box>

                              <Box sx={{ mb: 2 }}>
                                <FlexibleYearInput
                                  value={tempVocationalData.vocationalPeriodTo}
                                  onChange={(val) =>
                                    setTempVocationalData((r) => ({
                                      ...r,
                                      vocationalPeriodTo: val,
                                    }))
                                  }
                                  label="Period To"
                                />
                              </Box>

                              <Box sx={{ mb: 2 }}>
                                <Typography
                                  sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                                >
                                  Highest Attained
                                </Typography>
                                <FieldInput
                                  value={tempVocationalData.vocationalHighestAttained}
                                  onChange={(e) =>
                                    setTempVocationalData((r) => ({
                                      ...r,
                                      vocationalHighestAttained: e.target.value,
                                    }))
                                  }
                                  fullWidth
                                  size="small"
                                />
                              </Box>

                              <Box sx={{ mb: 2 }}>
                                <Typography
                                  sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                                >
                                  Year Graduated{' '}
                                  <Box
                                    component="span"
                                    sx={{ fontSize: '0.68rem', color: T.faint, fontWeight: 400 }}
                                  >
                                    (auto-filled)
                                  </Box>
                                </Typography>
                                <Box
                                  sx={{
                                    p: 1.5,
                                    bgcolor: T.accentFaint,
                                    borderRadius: 2,
                                    border: `1px solid ${T.accentBorder}`,
                                  }}
                                >
                                  <Typography sx={{ fontSize: '0.82rem', color: T.muted }}>
                                    {tempVocationalData.vocationalYearGraduated || '-'}
                                  </Typography>
                                </Box>
                              </Box>

                              <Box sx={{ mb: 2 }}>
                                <Typography
                                  sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}
                                >
                                  Honors Received
                                </Typography>
                                <FieldInput
                                  value={
                                    tempVocationalData.vocationalScholarshipAcademicHonorsReceived
                                  }
                                  onChange={(e) =>
                                    setTempVocationalData((r) => ({
                                      ...r,
                                      vocationalScholarshipAcademicHonorsReceived:
                                        e.target.value,
                                    }))
                                  }
                                  fullWidth
                                  size="small"
                                />
                              </Box>
                            </Box>
                          )}
                        </Box>

                        <Box
                          sx={{
                            px: 3.5,
                            py: 2,
                            borderTop: `1px solid ${T.divider}`,
                            bgcolor: '#f9f9f9',
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: 1.25,
                            flexShrink: 0,
                          }}
                        >
                          {!isEditingVocational ? (
                            <>
                              <AccentButton
                                onClick={handleDelete}
                                variant="outlined"
                                startIcon={<DeleteIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{
                                  fontSize: '0.8rem',
                                  borderColor: '#e57373',
                                  color: '#c62828',
                                  '&:hover': {
                                    bgcolor: 'rgba(198,40,40,0.04)',
                                    borderColor: '#c62828',
                                    transform: 'none',
                                  },
                                }}
                              >
                                Delete
                              </AccentButton>
                              <AccentButton
                                onClick={() => setIsEditingVocational(true)}
                                variant="contained"
                                startIcon={<EditIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{
                                  fontSize: '0.8rem',
                                  bgcolor: T.accent,
                                  color: '#fff',
                                  boxShadow: `0 2px 10px ${alpha(T.accent, 0.32)}`,
                                  '&:hover': { bgcolor: T.accentDark },
                                }}
                              >
                                Edit Record
                              </AccentButton>
                            </>
                          ) : (
                            <>
                              <AccentButton
                                onClick={() => {
                                  setTempVocationalData({ ...selectedVocational });
                                  setIsEditingVocational(false);
                                }}
                                variant="outlined"
                                startIcon={<CancelIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{
                                  fontSize: '0.8rem',
                                  borderColor: T.accentBorder,
                                  color: T.muted,
                                  '&:hover': {
                                    bgcolor: T.accentFaint,
                                    borderColor: T.accent,
                                    color: T.accent,
                                  },
                                }}
                              >
                                Cancel
                              </AccentButton>
                              <AccentButton
                                onClick={handleUpdate}
                                disabled={!hasChanges()}
                                variant="contained"
                                startIcon={<SaveIcon sx={{ fontSize: '14px !important' }} />}
                                sx={{
                                  fontSize: '0.8rem',
                                  bgcolor: T.accent,
                                  color: '#fff',
                                  boxShadow: `0 2px 10px ${alpha(T.accent, 0.32)}`,
                                  '&:hover': { bgcolor: T.accentDark },
                                }}
                              >
                                Save Changes
                              </AccentButton>
                            </>
                          )}
                        </Box>
                      </>
                    ) : (
                      <Box
                        sx={{
                          flexGrow: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexDirection: 'column',
                          gap: 1,
                        }}
                      >
                        <ConstructionIcon
                          sx={{ fontSize: 40, color: alpha(T.accent, 0.2) }}
                        />
                        <Typography
                          sx={{ fontSize: '0.88rem', color: T.faint, fontStyle: 'italic' }}
                        >
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
            <Alert
              onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
              severity={snackbar.severity}
              sx={{ width: '100%', borderRadius: 2 }}
            >
              {snackbar.message}
            </Alert>
          </Snackbar>
        </Box>
      </Fade>
    </>
  );
};

export default Vocational;
