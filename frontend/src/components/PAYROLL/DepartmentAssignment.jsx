import API_BASE_URL from '../../apiConfig';
import { fetchEmployeesByNumber } from '../../utils/employeeLookup';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import {
  Box, Grid, Modal, IconButton, CircularProgress, Snackbar, Alert,
  Paper, ToggleButton, ToggleButtonGroup, List, ListItem, Card,
  Typography, Fade, Avatar, Tooltip, Button, TextField, Chip, Checkbox,
} from '@mui/material';
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon,
  Save as SaveIcon, Cancel as CancelIcon, Close,
  Search as SearchIcon, ViewList as ViewListIcon, ViewModule as ViewModuleIcon,
  Domain as DomainIcon, Person as PersonIcon,
  ExpandMore as ExpandMoreIcon, ExpandLess as ExpandLessIcon,
  Refresh, People as PeopleIcon, ArrowBack as ArrowBackIcon,
  Reorder,
  CheckBox as CheckBoxIcon, CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
} from '@mui/icons-material';

import AccessDenied from '../AccessDenied';
import LoadingOverlay from '../LoadingOverlay';
import SuccessfulOverlay from '../SuccessfulOverlay';
import usePageAccess from '../../hooks/usePageAccess';
import { styled, alpha } from '@mui/material/styles';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import usePayrollRealtimeRefresh from '../../hooks/usePayrollRealtimeRefresh';
import { sortEmployeesByLastName } from '../../utils/sortEmployeesByLastName';

const T = {
  accent:       '#6d2323',
  accentDark:   '#5a1d1d',
  accentMid:    '#8B4545',
  accentFaint:  'rgba(109,35,35,0.06)',
  accentBorder: 'rgba(109,35,35,0.14)',
  accentHover:  'rgba(109,35,35,0.10)',
  headerGrad:   'linear-gradient(180deg,#6d2323 0%,#7e2c2c 100%)',
  rowEven:      '#ffffff',
  rowOdd:       'rgba(109,35,35,0.025)',
  rowHover:     'rgba(109,35,35,0.055)',
  text:         '#1a1a1a',
  muted:        '#6b6b6b',
  faint:        '#a0a0a0',
  surface:      '#ffffff',
  divider:      'rgba(0,0,0,0.08)',
};

// ── Shimmer wireframe ─────────────────────────────────────────
const shimmerKeyframes = `
@keyframes daShimmer {
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
}
@keyframes daPulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.60; }
}
`;

const Bone = ({ w = '100%', h = 14, r = 6, sx = {} }) => (
  <Box sx={{
    width: w, height: h, borderRadius: r,
    background: `linear-gradient(90deg, rgba(109,35,35,0.07) 25%, rgba(109,35,35,0.14) 50%, rgba(109,35,35,0.07) 75%)`,
    backgroundSize: '800px 100%',
    animation: 'daShimmer 1.6s infinite linear',
    flexShrink: 0, ...sx,
  }} />
);

const DeptWireframe = () => (
  <>
    <style>{shimmerKeyframes}</style>
    <Box sx={{
      py: { xs: 1, md: 2 }, mt: { xs: 0, md: -2 }, mb: { xs: 1, md: 2 },
      width: '100vw', maxWidth: '100%',
      position: 'relative', left: '63%', transform: 'translateX(-61%)',
      px: { xs: 2, sm: 3, md: 6 },
    }}>
      {/* Header bone */}
      <Box sx={{
        mb: 2, borderRadius: 3, overflow: 'hidden',
        border: `1px solid ${T.accentBorder}`,
        animation: 'daPulse 2s ease-in-out infinite',
      }}>
        <Box sx={{
          p: 3.5,
          background: 'linear-gradient(135deg,#fdf5f5 0%,#f0dede 100%)',
          display: 'flex', alignItems: 'center', gap: 2.5,
        }}>
          <Box sx={{ width: 52, height: 52, borderRadius: '50%', bgcolor: 'rgba(109,35,35,0.12)', flexShrink: 0 }} />
          <Box sx={{ flex: 1 }}>
            <Bone w={260} h={18} sx={{ mb: 1 }} />
            <Bone w={380} h={11} />
          </Box>
          <Bone w={110} h={32} r={20} sx={{ flexShrink: 0 }} />
          <Bone w={36} h={36} r="50%" sx={{ flexShrink: 0 }} />
        </Box>
      </Box>

      {/* Two-column layout bones */}
      <Grid container spacing={2}>
        {/* Left — assign form */}
        <Grid item xs={12} lg={5}>
          <Box sx={{
            borderRadius: 3, border: `1px solid ${T.accentBorder}`,
            bgcolor: '#fff', height: 'calc(100vh - 280px)',
            animation: 'daPulse 2s ease-in-out infinite',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Panel header */}
            <Box sx={{ px: 3, py: 1.5, borderBottom: `1px solid ${T.accentBorder}`, bgcolor: T.accentFaint, display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Bone w={14} h={14} r={2} sx={{ flexShrink: 0 }} />
              <Bone w={160} h={12} />
            </Box>

            {/* Form fields */}
            <Box sx={{ px: 3, pt: 2.5, pb: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box>
                <Bone w={120} h={10} sx={{ mb: 0.75 }} />
                <Box sx={{ height: 36, borderRadius: 2, border: `1px solid ${T.accentBorder}`, bgcolor: '#fafafa' }} />
              </Box>
              <Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
                  <Bone w={80} h={10} />
                  <Bone w={60} h={26} r={8} />
                </Box>
                <Box sx={{ height: 36, borderRadius: 2, border: `1px solid ${T.accentBorder}`, bgcolor: '#fafafa' }} />
              </Box>
            </Box>

            {/* Employee list skeleton */}
            <Box sx={{ px: 3, flex: 1, display: 'flex', flexDirection: 'column', gap: 0.75, overflow: 'hidden', pb: 2 }}>
              {[...Array(6)].map((_, i) => (
                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.25, py: 0.85, borderRadius: 1.5, border: `1px solid ${T.accentBorder}`, bgcolor: '#fafafa' }}>
                  <Bone w={18} h={18} r={3} sx={{ flexShrink: 0 }} />
                  <Bone w={26} h={26} r="50%" sx={{ flexShrink: 0 }} />
                  <Box sx={{ flex: 1 }}>
                    <Bone w={`${55 + (i % 3) * 15}%`} h={10} sx={{ mb: 0.5 }} />
                    <Bone w="35%" h={8} />
                  </Box>
                </Box>
              ))}
            </Box>

            {/* Footer button */}
            <Box sx={{ px: 3, py: 1.5, borderTop: `1px solid ${T.accentBorder}`, bgcolor: T.accentFaint }}>
              <Box sx={{ height: 38, borderRadius: 2, bgcolor: 'rgba(109,35,35,0.20)' }} />
            </Box>
          </Box>
        </Grid>

        {/* Right — records */}
        <Grid item xs={12} lg={7}>
          <Box sx={{
            borderRadius: 3, border: `1px solid ${T.accentBorder}`,
            bgcolor: '#fff', height: 'calc(100vh - 280px)',
            animation: 'daPulse 2s ease-in-out infinite',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Toolbar */}
            <Box sx={{ px: 3.5, py: 2, borderBottom: `1px solid ${T.accentBorder}`, bgcolor: T.accentFaint }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Bone w={16} h={16} r={2} sx={{ flexShrink: 0 }} />
                  <Bone w={160} h={14} />
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Bone w={70} h={24} r={12} />
                  <Bone w={64} h={28} r={6} />
                </Box>
              </Box>
              <Box sx={{ height: 36, borderRadius: 2, border: `1px solid ${T.accentBorder}`, bgcolor: '#fff' }} />
            </Box>

            {/* Department grid skeleton */}
            <Box sx={{ flex: 1, p: 2, overflow: 'hidden' }}>
              <Grid container spacing={1.5}>
                {[...Array(10)].map((_, i) => (
                  <Grid item xs={6} sm={4} md={2.4} key={i}>
                    <Box sx={{
                      p: '12px 14px', borderRadius: 2,
                      border: `1px solid ${T.accentBorder}`,
                      bgcolor: '#fafafa',
                      display: 'flex', flexDirection: 'column', gap: 0.75,
                    }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Bone w={30} h={30} r="50%" />
                        <Bone w={32} h={18} r={9} />
                      </Box>
                      <Box>
                        <Bone w="40%" h={8} sx={{ mb: 0.5 }} />
                        <Bone w={`${50 + (i % 4) * 10}%`} h={11} sx={{ mb: 0.3 }} />
                        <Bone w="65%" h={8} />
                      </Box>
                      <Bone w="50%" h={8} />
                    </Box>
                  </Grid>
                ))}
              </Grid>
            </Box>
          </Box>
        </Grid>
      </Grid>
    </Box>
  </>
);

// ─────────────────────────────────────────────────────────────

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
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

const scrollbarSx = {
  '&::-webkit-scrollbar': { width: 4 },
  '&::-webkit-scrollbar-thumb': { bgcolor: T.accentBorder, borderRadius: 2 },
  '&::-webkit-scrollbar-track': { bgcolor: 'transparent' },
};

const sortByLastName = (arr) => sortEmployeesByLastName(arr, (a) => a.name || a);

// ── Dept Code Autocomplete ────────────────────────────────────
const DeptCodeAutocomplete = ({ value, onChange, departmentList = [], placeholder = 'Type or select department code…', disabled = false }) => {
  const [query, setQuery] = useState(value || '');
  const [open, setOpen]   = useState(false);
  const ref               = useRef(null);

  useEffect(() => { setQuery(value || ''); }, [value]);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  const filtered = departmentList.filter(
    (d) => d.code.toLowerCase().includes(query.toLowerCase()) || (d.description || '').toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Box sx={{ position: 'relative', width: '100%' }} ref={ref}>
      <FieldInput value={query} onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        placeholder={placeholder} disabled={disabled} fullWidth autoComplete="off" size="small"
        InputProps={{
          startAdornment: <DomainIcon sx={{ color: T.muted, mr: 1, fontSize: 15 }} />,
          endAdornment: <IconButton size="small" sx={{ color: T.muted }} onClick={() => setOpen((p) => !p)} disabled={disabled}>{open ? <ExpandLessIcon sx={{ fontSize: 15 }} /> : <ExpandMoreIcon sx={{ fontSize: 15 }} />}</IconButton>,
        }} />
      {open && !disabled && (
        <Paper elevation={4} sx={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1400, maxHeight: 220, overflow: 'auto', mt: 0.75, borderRadius: 2, border: `1px solid ${T.accentBorder}`, ...scrollbarSx }}>
          {filtered.length > 0 ? (
            <List dense disablePadding>
              {filtered.map((dept) => (
                <ListItem key={dept.code} button onClick={() => { setQuery(dept.code); onChange(dept.code); setOpen(false); }}
                  sx={{ py: 0.9, px: 1.5, '&:hover': { bgcolor: T.accentFaint }, borderBottom: `1px solid ${T.divider}` }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <DomainIcon sx={{ fontSize: 14, color: T.accent, flexShrink: 0 }} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: T.text }}>{dept.code}</Typography>
                      {dept.description && <Typography sx={{ fontSize: '0.7rem', color: T.muted }} noWrap>{dept.description}</Typography>}
                    </Box>
                  </Box>
                </ListItem>
              ))}
            </List>
          ) : (
            <Box sx={{ p: 2, textAlign: 'center' }}>
              <Typography sx={{ fontSize: '0.8rem', color: T.faint, fontStyle: 'italic' }}>
                {query ? `No match for "${query}" — you can still use it` : 'No department codes found'}
              </Typography>
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
};

// ── Budget Dept Code Autocomplete (Appendix 33 allow-list only) ──
// Options come from the Appendix 33 layout's department tab — the same allow-list
// used by the Appendix 33 download modal's "Include" options. A manually typed code
// is shown long enough to explain the problem, but cannot be saved until corrected.
const BudgetCodeAutocomplete = ({
  value,
  onChange,
  allowedDepartments = [],
  scopesLoaded = false,
  scopesLoading = false,
  scopesError = '',
  placeholder = 'Same as department…',
  disabled = false,
}) => {
  const [query, setQuery] = useState(value || '');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => { setQuery(value || ''); }, [value]);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  const q = query.toLowerCase();
  const filtered = allowedDepartments.filter(
    (d) => String(d.code || '').toLowerCase().includes(q)
      || String(d.description || '').toLowerCase().includes(q),
  );
  const trimmedValue = String(value || '').trim();
  const allowedSet = new Set(
    allowedDepartments.map((d) => String(d.code || '').trim().toUpperCase()).filter(Boolean),
  );
  const isAllowedSelection = !trimmedValue || allowedSet.has(trimmedValue.toUpperCase());
  const validationError = scopesLoaded && !isAllowedSelection
    ? `"${trimmedValue}" is not enabled in the Appendix 33 layout's department tab.`
    : (scopesError && trimmedValue ? scopesError : '');

  return (
    <Box sx={{ position: 'relative', width: '100%' }} ref={ref}>
      <FieldInput
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        placeholder={placeholder}
        disabled={disabled}
        fullWidth
        autoComplete="off"
        size="small"
        error={Boolean(validationError)}
        helperText={validationError}
        InputProps={{
          startAdornment: <DomainIcon sx={{ color: T.muted, mr: 1, fontSize: 15 }} />,
          endAdornment: (
            <IconButton
              size="small"
              sx={{ color: trimmedValue ? '#c62828' : T.muted }}
              disabled={disabled || !trimmedValue}
              title={trimmedValue ? 'Clear budget override' : 'Open suggestions'}
              onClick={() => {
                if (trimmedValue) {
                  setQuery('');
                  onChange('');
                  setOpen(false);
                } else {
                  setOpen((p) => !p);
                }
              }}
            >
              {trimmedValue
                ? <Close sx={{ fontSize: 15 }} />
                : (open ? <ExpandLessIcon sx={{ fontSize: 15 }} /> : <ExpandMoreIcon sx={{ fontSize: 15 }} />)}
            </IconButton>
          ),
        }}
      />
      {open && !disabled && (
        <Paper elevation={4} sx={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1400, maxHeight: 220, overflow: 'auto', mt: 0.75, borderRadius: 2, border: `1px solid ${T.accentBorder}`, ...scrollbarSx }}>
          {filtered.length > 0 ? (
            <List dense disablePadding>
              {filtered.map((dept) => (
                <ListItem key={dept.code} button onClick={() => { setQuery(dept.code); onChange(dept.code); setOpen(false); }}
                  sx={{ py: 0.9, px: 1.5, '&:hover': { bgcolor: T.accentFaint }, borderBottom: `1px solid ${T.divider}` }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <DomainIcon sx={{ fontSize: 14, color: T.accent, flexShrink: 0 }} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: T.text }}>{dept.code}</Typography>
                      {dept.description && <Typography sx={{ fontSize: '0.7rem', color: T.muted }} noWrap>{dept.description}</Typography>}
                    </Box>
                  </Box>
                </ListItem>
              ))}
            </List>
          ) : (
            <Box sx={{ p: 2, textAlign: 'center' }}>
              <Typography sx={{ fontSize: '0.8rem', color: T.faint, fontStyle: 'italic' }}>
                {scopesError
                  ? 'Could not load the allowed departments from the Appendix 33 layout. Refresh and try again.'
                  : scopesLoading
                    ? 'Loading allowed departments…'
                    : scopesLoaded
                      ? (query
                        ? `No allowed department matches "${query}"`
                        : 'No departments are enabled in the Appendix 33 layout')
                      : 'Waiting for the Appendix 33 department configuration…'}
              </Typography>
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
};

// ── Single Employee Autocomplete ──────────────────────────────
const SingleEmployeeAutocomplete = ({ value, onChange, selectedEmployee, onEmployeeSelect, placeholder = 'Search employee…', disabled = false }) => {
  const [query, setQuery]     = useState('');
  const [employees, setEmps]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const debRef                = useRef(null);
  const ref                   = useRef(null);

  useEffect(() => { if (value && !selectedEmployee) fetchById(value); }, [value]); // eslint-disable-line
  useEffect(() => { if (selectedEmployee) setQuery(selectedEmployee.name || ''); else if (!value) setQuery(''); }, [selectedEmployee, value]);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  const search    = async (q)   => { setLoading(true); try { const r = await axios.get(`${API_BASE_URL}/Remittance/employees/search?q=${encodeURIComponent(q)}`, getAuthHeaders()); setEmps(r.data); } catch { setEmps([]); } finally { setLoading(false); } };
  const fetchAll  = async ()    => { setLoading(true); try { const r = await axios.get(`${API_BASE_URL}/Remittance/employees/search`, getAuthHeaders()); setEmps(r.data); } catch { setEmps([]); } finally { setLoading(false); } };
  const fetchById = async (num) => { try { const r = await axios.get(`${API_BASE_URL}/Remittance/employees/${num}`, getAuthHeaders()); onEmployeeSelect(r.data); setQuery(r.data.name || ''); } catch { /* silent */ } };

  return (
    <Box sx={{ position: 'relative', width: '100%' }} ref={ref}>
      <FieldInput value={query}
        onChange={(e) => {
          const v = e.target.value; setQuery(v); setOpen(true);
          if (selectedEmployee && v !== selectedEmployee.name) { onEmployeeSelect(null); onChange(''); }
          clearTimeout(debRef.current);
          debRef.current = setTimeout(() => { if (v.trim().length >= 2) search(v); else if (!v.trim()) fetchAll(); else setEmps([]); }, 300);
        }}
        onFocus={() => { setOpen(true); if (!employees.length && !loading) { query.length >= 2 ? search(query) : fetchAll(); } }}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        placeholder={placeholder} disabled={disabled} fullWidth autoComplete="off" size="small"
        InputProps={{
          startAdornment: <PersonIcon sx={{ color: T.muted, mr: 1, fontSize: 15 }} />,
          endAdornment: <IconButton size="small" sx={{ color: T.muted }} onClick={() => { if (!open) { setOpen(true); if (!employees.length && !loading) fetchAll(); } else setOpen(false); }}>{open ? <ExpandLessIcon sx={{ fontSize: 15 }} /> : <ExpandMoreIcon sx={{ fontSize: 15 }} />}</IconButton>,
        }} />
      {open && (
        <Paper elevation={4} sx={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1400, maxHeight: 260, overflow: 'auto', mt: 0.75, borderRadius: 2, border: `1px solid ${T.accentBorder}`, ...scrollbarSx }}>
          {loading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2, gap: 1 }}>
              <CircularProgress size={16} sx={{ color: T.accent }} /><Typography sx={{ fontSize: '0.8rem', color: T.muted }}>Loading…</Typography>
            </Box>
          ) : employees.length > 0 ? (
            <List dense disablePadding>
              {employees.map((emp) => (
                <ListItem key={emp.employeeNumber} button onClick={() => { onEmployeeSelect(emp); setQuery(emp.name); setOpen(false); onChange(emp.employeeNumber); }}
                  sx={{ py: 1, px: 1.5, '&:hover': { bgcolor: T.accentFaint }, borderBottom: `1px solid ${T.divider}` }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Avatar sx={{ width: 28, height: 28, fontSize: '0.72rem', bgcolor: T.accent, color: '#fff', fontWeight: 700 }}>{emp.name?.charAt(0)?.toUpperCase() || '?'}</Avatar>
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
              <Typography sx={{ fontSize: '0.8rem', color: T.faint, fontStyle: 'italic' }}>{query.length >= 2 ? `No employees found for "${query}"` : 'Type to search or scroll to browse'}</Typography>
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
};

// ── Dept Grid Card ────────────────────────────────────────────
const DeptCard = ({ department, onClick }) => (
  <Box onClick={onClick} sx={{ p: '12px 14px', borderRadius: 2, cursor: 'pointer', bgcolor: '#fff', border: `1px solid ${T.accentBorder}`, transition: 'all 0.15s ease', '&:hover': { bgcolor: T.rowHover, borderColor: T.accent, transform: 'translateY(-2px)', boxShadow: `0 4px 16px ${alpha(T.accent, 0.12)}` }, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <Avatar sx={{ width: 30, height: 30, bgcolor: alpha(T.accent, 0.1), color: T.accent }}><DomainIcon sx={{ fontSize: 15 }} /></Avatar>
      <Box sx={{ px: 1, py: 0.25, borderRadius: 6, bgcolor: alpha(T.accent, 0.07), border: `1px solid ${alpha(T.accent, 0.15)}`, display: 'flex', alignItems: 'center', gap: 0.4 }}>
        <PeopleIcon sx={{ fontSize: 10, color: T.accent }} />
        <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: T.accent }}>{department.employees.length}</Typography>
      </Box>
    </Box>
    <Box>
      <Typography sx={{ fontSize: '0.68rem', color: T.faint, mb: 0.1 }}>Code</Typography>
      <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: T.text, lineHeight: 1.2 }} noWrap>{department.code}</Typography>
      {department.description && <Typography sx={{ fontSize: '0.68rem', color: T.muted, mt: 0.2 }} noWrap>{department.description}</Typography>}
    </Box>
    <Typography sx={{ fontSize: '0.66rem', color: T.faint }}>{department.employees.length === 1 ? '1 employee' : `${department.employees.length} employees`}</Typography>
  </Box>
);

// ── Dept List Row ─────────────────────────────────────────────
const DeptRow = ({ department, index, onClick }) => (
  <Box onClick={onClick} sx={{ px: 2, py: 1.25, display: 'grid', gridTemplateColumns: '1fr auto', gap: 1, alignItems: 'center', borderRadius: 1.5, cursor: 'pointer', bgcolor: index % 2 === 0 ? T.rowEven : T.rowOdd, border: '1px solid transparent', transition: 'background 0.13s ease', '&:hover': { bgcolor: T.rowHover } }}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
      <DomainIcon sx={{ fontSize: 15, color: T.accent, flexShrink: 0 }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: T.text }} noWrap>{department.code}</Typography>
        {department.description && <Typography sx={{ fontSize: '0.7rem', color: T.muted }} noWrap>{department.description}</Typography>}
      </Box>
    </Box>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.2, py: 0.3, borderRadius: 6, bgcolor: alpha(T.accent, 0.07), border: `1px solid ${alpha(T.accent, 0.15)}` }}>
      <PeopleIcon sx={{ fontSize: 11, color: T.accent }} />
      <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: T.accent }}>{department.employees.length}</Typography>
    </Box>
  </Box>
);

// ── Modal Header ──────────────────────────────────────────────
const ModalHeader = ({ title, subtitle, chips = [], onBack, onClose }) => (
  <Box sx={{ px: 3.5, py: 2.5, background: T.headerGrad, display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', overflow: 'hidden', flexShrink: 0 }}>
    <Box sx={{ position: 'absolute', top: -40, right: -30, width: 140, height: 140, borderRadius: '50%', bgcolor: 'rgba(255,255,255,0.04)' }} />
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, position: 'relative', zIndex: 1 }}>
      <Avatar sx={{ width: 44, height: 44, bgcolor: 'rgba(255,255,255,0.15)', color: '#fff' }}><DomainIcon sx={{ fontSize: 22 }} /></Avatar>
      <Box>
        <Typography sx={{ fontSize: '1rem', fontWeight: 800, color: '#fff', lineHeight: 1.2 }}>{title}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.3 }}>
          {chips.map((c) => <Chip key={c} label={c} size="small" sx={{ height: 18, fontSize: '0.68rem', bgcolor: 'rgba(255,255,255,0.18)', color: '#fff', fontWeight: 700 }} />)}
          {subtitle && <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.68)' }}>{subtitle}</Typography>}
        </Box>
      </Box>
    </Box>
    <Box sx={{ display: 'flex', gap: 1, position: 'relative', zIndex: 1 }}>
      {onBack && <IconButton onClick={onBack} size="small" sx={{ color: 'rgba(255,255,255,0.75)', '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' } }}><ArrowBackIcon sx={{ fontSize: 17 }} /></IconButton>}
      <IconButton onClick={onClose} size="small" sx={{ color: 'rgba(255,255,255,0.75)', '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' } }}><Close sx={{ fontSize: 17 }} /></IconButton>
    </Box>
  </Box>
);

// ════════════════════════════════════════════════════════════
// ── Main Component
// ════════════════════════════════════════════════════════════
const DepartmentAssignment = () => {
  const { settings } = useSystemSettings();

  const [data, setData]                     = useState([]);
  const [departmentData, setDepartmentData] = useState([]);
  const [departmentList, setDepartmentList] = useState([]);

  const [selectedCode, setSelectedCode]     = useState('');
  const [assignBudgetCode, setAssignBudgetCode] = useState('');
  const [appendix33DeptScopes, setAppendix33DeptScopes] = useState([]);
  const [appendix33ScopesLoaded, setAppendix33ScopesLoaded] = useState(false);
  const [appendix33ScopesLoading, setAppendix33ScopesLoading] = useState(true);
  const [appendix33ScopesError, setAppendix33ScopesError] = useState('');
  const [singleEmployee, setSingleEmployee] = useState(null);
  const [singleEmpNum, setSingleEmpNum]     = useState('');

  const [selectMode, setSelectMode]         = useState(false);
  const [empSearchQuery, setEmpSearchQuery] = useState('');
  const [empList, setEmpList]               = useState([]);
  const [empListLoading, setEmpListLoading] = useState(false);
  const [employeeQueue, setEmployeeQueue]   = useState([]);
  const empDebRef                           = useRef(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading]       = useState(false);
  const [viewMode, setViewMode]     = useState('grid');
  const [snackbar, setSnackbar]     = useState({ open: false, message: '', severity: 'success' });
  const [successOpen, setSuccessOpen] = useState(false);
  const [successAction, setSuccessAction] = useState('create');

  // Modal state
  const [modalOpen, setModalOpen]                       = useState(false);
  const [selectedDepartment, setSelectedDepartment]     = useState(null);
  const [deptEmpDetails, setDeptEmpDetails]             = useState({});
  const [editAssignment, setEditAssignment]             = useState(null);
  const [originalAssignment, setOriginalAssignment]     = useState(null);
  const [selectedEditEmployee, setSelectedEditEmployee] = useState(null);
  const [modalMemberSearch, setModalMemberSearch]       = useState('');
  const [isEditingModal, setIsEditingModal]             = useState(false);

  const showSnackbar = (msg, sev = 'success') => setSnackbar({ open: true, message: msg, severity: sev });
  const { hasAccess, loading: accessLoading } = usePageAccess('department-assignment');

  useEffect(() => { fetchAssignments(); fetchDepartmentList(); fetchAppendix33DeptScopes(); }, []);
  useEffect(() => { if (selectMode) fetchEmpList(''); }, [selectMode]); // eslint-disable-line

  const fetchAssignments = async () => {
    try {
      const r = await axios.get(`${API_BASE_URL}/api/department-assignment`, getAuthHeaders());
      setData(Array.isArray(r.data) ? r.data : []);
    } catch { showSnackbar('Failed to fetch department assignments.', 'error'); }
  };

  const fetchDepartmentList = async () => {
    try {
      const r = await axios.get(`${API_BASE_URL}/api/department-table`, getAuthHeaders());
      setDepartmentList(Array.isArray(r.data) ? r.data : []);
    } catch { /* silent */ }
  };

  // Appendix 33 allow-list: the only departments an export can be charged to
  // (same source as the Appendix 33 download modal's "Include" options).
  const fetchAppendix33DeptScopes = async () => {
    setAppendix33ScopesLoading(true);
    setAppendix33ScopesError('');
    try {
      const r = await axios.get(
        `${API_BASE_URL}/PayrollExportRoute/export-appendix33/scopes`,
        getAuthHeaders(),
      );
      const list = Array.isArray(r.data?.departments) ? r.data.departments : [];
      setAppendix33DeptScopes(list.map((d) => ({ code: d.code, description: d.description || d.code })));
      setAppendix33ScopesLoaded(true);
    } catch {
      setAppendix33DeptScopes([]);
      setAppendix33ScopesLoaded(false);
      setAppendix33ScopesError('Could not load the allowed departments from the Appendix 33 layout.');
    } finally {
      setAppendix33ScopesLoading(false);
    }
  };

  const fetchEmpList = async (q) => {
    setEmpListLoading(true);
    try {
      const url = q.trim().length >= 2
        ? `${API_BASE_URL}/Remittance/employees/search?q=${encodeURIComponent(q)}`
        : `${API_BASE_URL}/Remittance/employees/search`;
      const r = await axios.get(url, getAuthHeaders());
      setEmpList(r.data);
    } catch { setEmpList([]); } finally { setEmpListLoading(false); }
  };

  usePayrollRealtimeRefresh(() => { fetchAssignments(); fetchDepartmentList(); fetchAppendix33DeptScopes(); });

  const appendix33DeptCodeSet = useMemo(
    () => new Set(appendix33DeptScopes.map((d) => String(d.code || '').trim().toUpperCase()).filter(Boolean)),
    [appendix33DeptScopes],
  );

  // A budget department only matters for the Appendix 33 export, so it is only
  // valid when the code is on that dialog's allowed-departments list. Until the
  // allow-list loads we stay neutral; once loaded, an off-list code warns.
  const getBudgetScopeWarning = (code) => {
    const v = String(code || '').trim();
    if (!v) return '';
    if (appendix33ScopesError) return appendix33ScopesError;
    if (!appendix33ScopesLoaded) return 'Waiting for the Appendix 33 department configuration to load.';
    if (!appendix33DeptCodeSet.has(v.toUpperCase())) {
      return `“${v}” is not enabled in the Appendix 33 layout’s department tab, so this payroll budget override will have no effect on the export until it is allowed there.`;
    }
    return '';
  };

  const isBudgetCodeAllowed = (code) => {
    const v = String(code || '').trim();
    if (!v) return true;
    if (appendix33ScopesError || !appendix33ScopesLoaded) return false;
    return appendix33DeptCodeSet.has(v.toUpperCase());
  };

  useEffect(() => {
    const descMap = {};
    departmentList.forEach((d) => { descMap[d.code] = d.description || ''; });
    const grouped = data.reduce((acc, a) => {
      const code = a.code || 'Unassigned';
      if (!acc[code]) acc[code] = { code, description: descMap[code] || '', employees: [] };
      acc[code].employees.push(a);
      return acc;
    }, {});
    setDepartmentData(
      Object.values(grouped).map((dept) => ({
        ...dept,
        description: descMap[dept.code] || dept.description || '',
        employees: sortByLastName(dept.employees),
      }))
    );
  }, [data, departmentList]);

  const selectedNums = new Set(employeeQueue.map((e) => String(e.employeeNumber)));

  const toggleEmp = (emp) => {
    const num = String(emp.employeeNumber);
    setEmployeeQueue((prev) => selectedNums.has(num) ? prev.filter((e) => String(e.employeeNumber) !== num) : [...prev, emp]);
  };

  const handleSelectAll = () =>
    setEmployeeQueue((prev) => {
      const existing = new Map(prev.map((e) => [String(e.employeeNumber), e]));
      empList.forEach((e) => existing.set(String(e.employeeNumber), e));
      return [...existing.values()];
    });

  const handleDeselectAll = () =>
    setEmployeeQueue((prev) => prev.filter((e) => !empList.find((x) => String(x.employeeNumber) === String(e.employeeNumber))));

  const exitSelectMode = () => { setSelectMode(false); setEmpSearchQuery(''); setEmpList([]); setEmployeeQueue([]); };

  const handleAssign = async () => {
    const toAssign = selectMode ? employeeQueue : singleEmployee ? [singleEmployee] : [];
    if (toAssign.length === 0) { showSnackbar('Please select at least one employee', 'error'); return; }
    const budgetWarning = getBudgetScopeWarning(assignBudgetCode);
    if (budgetWarning || !isBudgetCodeAllowed(assignBudgetCode)) {
      showSnackbar(budgetWarning || 'Choose an allowed Budget Department from the Appendix 33 layout.', 'error');
      return;
    }
    setLoading(true);
    let ok = 0, fail = 0, firstError = '';
    for (const emp of toAssign) {
      try { await axios.post(`${API_BASE_URL}/api/department-assignment`, { code: selectedCode, budgetCode: assignBudgetCode, employeeNumber: emp.employeeNumber, name: emp.name }, getAuthHeaders()); ok++; }
      catch (err) {
        fail++;
        if (!firstError) firstError = err?.response?.data?.error || '';
      }
    }
    setLoading(false);
    setSingleEmployee(null); setSingleEmpNum('');
    exitSelectMode();
    setSelectedCode('');
    setAssignBudgetCode('');
    fetchAssignments();
    if (fail === 0) {
      setSuccessAction(ok > 1 ? 'bulk' : 'create');
      setSuccessOpen(true);
    } else showSnackbar(`${ok} assigned, ${fail} failed.${firstError ? ` ${firstError}` : ''}`, 'warning');
  };

  const handleUpdate = async () => {
    if (!editAssignment) return;
    const budgetWarning = getBudgetScopeWarning(editAssignment.budgetCode);
    if (budgetWarning || !isBudgetCodeAllowed(editAssignment.budgetCode)) {
      showSnackbar(budgetWarning || 'Choose an allowed Budget Department from the Appendix 33 layout.', 'error');
      return;
    }
    try {
      await axios.put(`${API_BASE_URL}/api/department-assignment/${editAssignment.id}`, editAssignment, getAuthHeaders());
      setSuccessAction('edit');
      setSuccessOpen(true);
      await fetchAssignments();
      const res = await axios.get(`${API_BASE_URL}/api/department-assignment`, getAuthHeaders());
      const all = Array.isArray(res.data) ? res.data : [];
      if (selectedDepartment) {
        setSelectedDepartment((p) => ({
          ...p,
          employees: sortByLastName(all.filter((a) => a.code === selectedDepartment.code)),
        }));
      }
      setOriginalAssignment({ ...editAssignment });
      setIsEditingModal(false);
    } catch { showSnackbar('Failed to update assignment.', 'error'); }
  };

  const handleDelete = async (id) => {
    try {
      await axios.delete(`${API_BASE_URL}/api/department-assignment/${id}`, getAuthHeaders());
      setSuccessAction('delete');
      setSuccessOpen(true);
      await fetchAssignments();
      if (selectedDepartment) {
        const updated = selectedDepartment.employees.filter((e) => e.id !== id);
        setSelectedDepartment((p) => ({ ...p, employees: updated }));
        if (editAssignment?.id === id) {
          setEditAssignment(null);
          setOriginalAssignment(null);
          setSelectedEditEmployee(null);
          setIsEditingModal(false);
        }
      }
    } catch { showSnackbar('Failed to delete assignment.', 'error'); }
  };

  const handleOpenModal = async (department) => {
    setSelectedDepartment(department);
    setEditAssignment(null);
    setOriginalAssignment(null);
    setSelectedEditEmployee(null);
    setIsEditingModal(false);
    setModalMemberSearch('');
    setModalOpen(true);

    const map = {};
    const members = department.employees.filter((a) => a.employeeNumber);
    const found = await fetchEmployeesByNumber(members.map((a) => a.employeeNumber));
    members.forEach((a) => {
      map[a.employeeNumber] =
        found.get(String(a.employeeNumber).trim()) ||
        { employeeNumber: a.employeeNumber, name: a.name || 'Unknown' };
    });
    setDeptEmpDetails(map);

    // Auto-select first member
    if (department.employees.length > 0) {
      const first = department.employees[0];
      setEditAssignment({ ...first });
      setOriginalAssignment({ ...first });
      if (first.employeeNumber) {
        try {
          const r = await axios.get(`${API_BASE_URL}/Remittance/employees/${first.employeeNumber}`, getAuthHeaders());
          setSelectedEditEmployee(r.data);
        } catch { setSelectedEditEmployee(null); }
      }
    }
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setEditAssignment(null);
    setOriginalAssignment(null);
    setSelectedEditEmployee(null);
    setSelectedDepartment(null);
    setDeptEmpDetails({});
    setModalMemberSearch('');
    setIsEditingModal(false);
  };

  const hasChanges = () =>
    editAssignment && originalAssignment &&
    (editAssignment.code !== originalAssignment.code ||
      (editAssignment.budgetCode || '') !== (originalAssignment.budgetCode || '') ||
      editAssignment.employeeNumber !== originalAssignment.employeeNumber);

  // ── Access guard ─────────────────────────────────────────────
  if (accessLoading) return <DeptWireframe />;
  if (hasAccess === false) return <AccessDenied title="Access Denied" message="You do not have permission to access Department Assignment." returnPath="/admin-home" returnButtonText="Return to Home" />;

  const filteredDepartmentData = departmentData.filter((d) => {
    const term = searchTerm.toLowerCase();
    if (!term) return true;
    return (d.code?.toLowerCase() || '').includes(term) || (d.description?.toLowerCase() || '').includes(term) ||
           d.employees.some((e) => (e.name?.toLowerCase() || '').includes(term) || (e.employeeNumber?.toString() || '').includes(term));
  });

  const filteredModalMembers = selectedDepartment ? selectedDepartment.employees.filter((emp) => {
    const detail = deptEmpDetails[emp.employeeNumber];
    const name   = (detail?.name || emp.name || '').toLowerCase();
    const num    = (emp.employeeNumber?.toString() || '').toLowerCase();
    const term   = modalMemberSearch.toLowerCase();
    return !term || name.includes(term) || num.includes(term);
  }) : [];

  const selectedDeptObj = departmentList.find((d) => d.code === selectedCode);
  const assignBudgetAllowed = isBudgetCodeAllowed(assignBudgetCode);
  const assignBudgetWarning = getBudgetScopeWarning(assignBudgetCode);
  const canAssign       = (selectMode ? employeeQueue.length > 0 : !!singleEmployee) && assignBudgetAllowed;
  const assignCount     = selectMode ? employeeQueue.length : singleEmployee ? 1 : 0;

  return (
    <>
      <style>{shimmerKeyframes}</style>
      <Fade in timeout={400}>
        <Box sx={{ py: { xs: 1, md: 2 }, mt: { xs: 0, md: -2 }, mb: { xs: 1, md: 2 }, width: '100vw', maxWidth: '100%', position: 'relative', left: '63%', transform: 'translateX(-61%)', px: { xs: 2, sm: 3, md: 6 } }}>

          {/* Page Header */}
          <SectionCard sx={{ mb: 2, overflow: 'hidden' }}>
            <Box sx={{ px: 4, py: 3, background: 'linear-gradient(135deg, #fdf5f5 0%, #f0dede 100%)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', overflow: 'hidden' }}>
              <Box sx={{ position: 'absolute', top: -50, right: -50, width: 200, height: 200, borderRadius: '50%', background: 'radial-gradient(circle, rgba(109,35,35,0.1) 0%, transparent 70%)' }} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, position: 'relative', zIndex: 1 }}>
                <DomainIcon sx={{ fontSize: 32, color: T.accent }} />
                <Box>
                  <Typography sx={{ fontSize: '1.25rem', fontWeight: 900, color: T.accent, lineHeight: 1.2, mb: 0.3 }}>Department Assignment Management</Typography>
                  <Typography sx={{ fontSize: '0.82rem', color: T.accentMid, fontWeight: 700, opacity: 0.9 }}>Administrative Panel • Assign and manage employee department records</Typography>
                </Box>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, position: 'relative', zIndex: 1 }}>
                <Box sx={{ px: 2.5, py: 0.75, borderRadius: 6, bgcolor: alpha(T.accent, 0.1), border: `1px solid ${alpha(T.accent, 0.2)}` }}>
                  <Typography sx={{ fontSize: '0.8rem', color: T.accent, fontWeight: 700 }}>{data.length} {data.length === 1 ? 'assignment' : 'assignments'}</Typography>
                </Box>
                <Tooltip title="Refresh Data">
                  <IconButton onClick={() => { fetchAssignments(); fetchDepartmentList(); fetchAppendix33DeptScopes(); }} sx={{ bgcolor: alpha(T.accent, 0.08), color: T.accent, width: 36, height: 36, '&:hover': { bgcolor: alpha(T.accent, 0.15) } }}>
                    <Refresh sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          </SectionCard>

          <Grid container spacing={2}>
            {/* LEFT: Assign Form */}
            <Grid item xs={12} lg={5}>
              <SectionCard sx={{ height: 'calc(100vh - 280px)', display: 'flex', flexDirection: 'column' }}>
                <Box sx={{ px: 3, py: 1.25, borderBottom: `1px solid ${T.divider}`, display: 'flex', alignItems: 'center', gap: 1.5, bgcolor: T.accentFaint, flexShrink: 0 }}>
                  <AddIcon sx={{ fontSize: 15, color: T.accent }} />
                  <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.accent }}>Assign to Department</Typography>
                </Box>

                <Box sx={{ px: 3, pt: 2, pb: 1, flexShrink: 0 }}>
                  <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>Department Code</Typography>
                  <DeptCodeAutocomplete value={selectedCode} onChange={setSelectedCode} departmentList={departmentList} />
                  {selectedDeptObj?.description && (
                    <Typography sx={{ fontSize: '0.72rem', color: T.muted, mt: 0.5, ml: 0.5 }}>{selectedDeptObj.description}</Typography>
                  )}

                  <Box sx={{ mt: 1.75 }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent, mb: 0.75 }}>
                      Budget Department (payroll charge)
                    </Typography>
                    <BudgetCodeAutocomplete
                      value={assignBudgetCode}
                      onChange={setAssignBudgetCode}
                      allowedDepartments={appendix33DeptScopes}
                      scopesLoaded={appendix33ScopesLoaded}
                      scopesLoading={appendix33ScopesLoading}
                      scopesError={appendix33ScopesError}
                      placeholder="Same as department…"
                    />
                    {assignBudgetWarning && (
                      <Typography sx={{ fontSize: '0.7rem', color: '#b45309', mt: 0.75, ml: 0.5 }}>
                        {assignBudgetWarning}
                      </Typography>
                    )}
                    <Typography sx={{ fontSize: '0.68rem', color: T.muted, mt: 0.75, ml: 0.5 }}>
                      Optional. Set only when the payroll budget comes from another department (e.g. employee is in CAS but charged to CEN). Only departments enabled in the Appendix 33 layout are available here. Leave blank to use the department code above.
                    </Typography>
                  </Box>

                  <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: T.accent }}>
                      Employee <Box component="span" sx={{ color: '#c62828' }}>*</Box>
                    </Typography>
                    <AccentButton size="small" variant={selectMode ? 'contained' : 'outlined'}
                      onClick={() => { if (selectMode) exitSelectMode(); else { setSelectMode(true); setSingleEmployee(null); setSingleEmpNum(''); } }}
                      startIcon={selectMode ? <CheckBoxIcon sx={{ fontSize: '13px !important' }} /> : <CheckBoxOutlineBlankIcon sx={{ fontSize: '13px !important' }} />}
                      sx={{ fontSize: '0.72rem', px: 1.25, py: 0.3, height: 26, bgcolor: selectMode ? T.accent : 'transparent', color: selectMode ? '#fff' : T.accent, borderColor: T.accentBorder, '&:hover': { bgcolor: selectMode ? T.accentDark : T.accentFaint, borderColor: T.accent, transform: 'none' } }}>
                      {selectMode ? 'Cancel' : 'Select'}
                    </AccentButton>
                  </Box>

                  {!selectMode && (
                    <Box sx={{ mt: 0.75 }}>
                      <SingleEmployeeAutocomplete value={singleEmpNum} onChange={setSingleEmpNum} selectedEmployee={singleEmployee} onEmployeeSelect={setSingleEmployee} placeholder="Search employee to assign…" />
                      {singleEmployee && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 1, p: '10px 12px', borderRadius: 2, border: `1px solid ${alpha(T.accent, 0.25)}`, bgcolor: T.accentFaint }}>
                          <Avatar sx={{ width: 32, height: 32, bgcolor: T.accent, color: '#fff', fontSize: '0.75rem', fontWeight: 700 }}>{singleEmployee.name?.charAt(0)?.toUpperCase() || '?'}</Avatar>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography noWrap sx={{ fontSize: '0.83rem', fontWeight: 700, color: T.text }}>{singleEmployee.name}</Typography>
                            <Typography sx={{ fontSize: '0.7rem', color: T.muted }}>#{singleEmployee.employeeNumber}</Typography>
                          </Box>
                          {selectedCode && <Chip label={`→ ${selectedCode}`} size="small" sx={{ fontSize: '0.65rem', height: 18, bgcolor: alpha(T.accent, 0.08), color: T.accent, fontWeight: 700 }} />}
                          <IconButton size="small" onClick={() => { setSingleEmployee(null); setSingleEmpNum(''); }} sx={{ color: '#c62828', width: 22, height: 22, '&:hover': { bgcolor: 'rgba(198,40,40,0.1)' } }}>
                            <Close sx={{ fontSize: 12 }} />
                          </IconButton>
                        </Box>
                      )}
                    </Box>
                  )}

                  {selectMode && (
                    <Box sx={{ mt: 0.75 }}>
                      <FieldInput value={empSearchQuery}
                        onChange={(e) => { const v = e.target.value; setEmpSearchQuery(v); clearTimeout(empDebRef.current); empDebRef.current = setTimeout(() => fetchEmpList(v), 300); }}
                        placeholder="Search employees…" fullWidth autoComplete="off" size="small"
                        InputProps={{ startAdornment: <SearchIcon sx={{ fontSize: 15, color: T.muted, mr: 0.5 }} /> }} />
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 0.75, px: 0.25 }}>
                        <Typography sx={{ fontSize: '0.7rem', color: T.muted }}>
                          {empList.length} result{empList.length !== 1 ? 's' : ''}
                          {employeeQueue.length > 0 && <Box component="span" sx={{ ml: 0.75, fontWeight: 700, color: T.accent }}>· {employeeQueue.length} selected</Box>}
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                          <Box onClick={handleSelectAll} sx={{ px: 1.25, py: 0.3, borderRadius: 1, fontSize: '0.7rem', fontWeight: 700, color: T.accent, bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}`, cursor: 'pointer', userSelect: 'none', '&:hover': { bgcolor: T.accentHover } }}>Select all</Box>
                          <Box onClick={handleDeselectAll} sx={{ px: 1.25, py: 0.3, borderRadius: 1, fontSize: '0.7rem', fontWeight: 700, color: '#666', bgcolor: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.1)', cursor: 'pointer', userSelect: 'none', '&:hover': { bgcolor: 'rgba(0,0,0,0.08)', color: '#c62828' } }}>Deselect all</Box>
                        </Box>
                      </Box>
                    </Box>
                  )}
                </Box>

                {selectMode && (
                  <Box sx={{ px: 3, pb: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {empListLoading ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 1 }}>
                        <CircularProgress size={16} sx={{ color: T.accent }} />
                        <Typography sx={{ fontSize: '0.8rem', color: T.muted }}>Loading…</Typography>
                      </Box>
                    ) : empList.length === 0 ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, borderRadius: 2, border: `1.5px dashed rgba(0,0,0,0.13)`, bgcolor: 'rgba(0,0,0,0.015)' }}>
                        <Typography sx={{ fontSize: '0.8rem', color: T.faint, fontStyle: 'italic' }}>No employees found</Typography>
                      </Box>
                    ) : (
                      <Box sx={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0.4, ...scrollbarSx }}>
                        {empList.map((emp) => {
                          const isSel = selectedNums.has(String(emp.employeeNumber));
                          return (
                            <Box key={emp.employeeNumber} onClick={() => toggleEmp(emp)}
                              sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.25, py: 0.85, borderRadius: 1.5, cursor: 'pointer', bgcolor: isSel ? T.accentFaint : 'rgba(0,0,0,0.015)', border: `1px solid ${isSel ? T.accentBorder : 'transparent'}`, transition: 'all 0.13s', '&:hover': { bgcolor: isSel ? T.accentHover : 'rgba(0,0,0,0.04)' }, flexShrink: 0 }}>
                              <Checkbox checked={isSel} onChange={() => toggleEmp(emp)} onClick={(e) => e.stopPropagation()} size="small" sx={{ p: 0, color: T.accentBorder, '&.Mui-checked': { color: T.accent }, flexShrink: 0 }} />
                              <Avatar sx={{ width: 26, height: 26, fontSize: '0.68rem', bgcolor: isSel ? T.accent : 'rgba(0,0,0,0.1)', color: isSel ? '#fff' : T.muted, fontWeight: 700, transition: 'all 0.15s', flexShrink: 0 }}>{emp.name?.charAt(0)?.toUpperCase() || '?'}</Avatar>
                              <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Typography noWrap sx={{ fontSize: '0.8rem', fontWeight: 700, color: isSel ? T.accent : T.text }}>{emp.name}</Typography>
                                <Typography sx={{ fontSize: '0.68rem', color: T.muted }}>#{emp.employeeNumber}</Typography>
                              </Box>
                            </Box>
                          );
                        })}
                      </Box>
                    )}
                  </Box>
                )}

                {!selectMode && <Box sx={{ flex: 1 }} />}

                <Box sx={{ px: 3, py: 1.5, borderTop: `1px solid ${T.divider}`, bgcolor: T.accentFaint, flexShrink: 0 }}>
                  <AccentButton onClick={handleAssign} variant="contained"
                    startIcon={loading ? <CircularProgress size={14} color="inherit" /> : <AddIcon sx={{ fontSize: '16px !important' }} />}
                    fullWidth disabled={loading || !canAssign}
                    sx={{ height: 38, bgcolor: T.accent, color: '#fff', boxShadow: `0 2px 10px ${alpha(T.accent, 0.32)}`, '&:hover': { bgcolor: T.accentDark }, '&:disabled': { bgcolor: `${alpha(T.accent, 0.35)} !important`, color: '#fff !important' } }}>
                    {loading ? 'Assigning…' : `Assign ${assignCount > 0 ? `${assignCount} ` : ''}Employee${assignCount !== 1 ? 's' : ''}`}
                  </AccentButton>
                </Box>
              </SectionCard>
            </Grid>

            {/* RIGHT: Records */}
            <Grid item xs={12} lg={7}>
              <SectionCard sx={{ height: 'calc(100vh - 280px)', display: 'flex', flexDirection: 'column' }}>
                <Box sx={{ px: 3.5, py: 2, borderBottom: `1px solid ${T.divider}`, bgcolor: T.accentFaint, flexShrink: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <Reorder sx={{ fontSize: 17, color: T.accent }} />
                      <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: T.text }}>Department Records</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <Box sx={{ px: 1.5, py: 0.4, borderRadius: 6, bgcolor: alpha(T.accent, 0.08), border: `1px solid ${alpha(T.accent, 0.15)}` }}>
                        <Typography sx={{ fontSize: '0.72rem', color: T.accent, fontWeight: 700 }}>{filteredDepartmentData.length} dept{filteredDepartmentData.length !== 1 ? 's' : ''}</Typography>
                      </Box>
                      <ToggleButtonGroup value={viewMode} exclusive onChange={(_, v) => v && setViewMode(v)} size="small"
                        sx={{ '& .MuiToggleButton-root': { px: 1, py: 0.35, border: `1px solid ${T.accentBorder}`, color: T.muted, '&.Mui-selected': { bgcolor: T.accentFaint, color: T.accent } } }}>
                        <ToggleButton value="grid"><ViewModuleIcon sx={{ fontSize: 14 }} /></ToggleButton>
                        <ToggleButton value="list"><ViewListIcon sx={{ fontSize: 14 }} /></ToggleButton>
                      </ToggleButtonGroup>
                    </Box>
                  </Box>
                  <FieldInput size="small" placeholder="Search by department code, description, or employee name…"
                    value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} fullWidth
                    InputProps={{ startAdornment: <SearchIcon sx={{ fontSize: 15, color: T.muted, mr: 0.5 }} /> }} />
                </Box>

                <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 2, ...scrollbarSx }}>
                  {filteredDepartmentData.length === 0 ? (
                    <Box sx={{ py: 10, textAlign: 'center' }}>
                      <Box sx={{ width: 72, height: 72, borderRadius: '50%', bgcolor: T.accentFaint, display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2 }}>
                        <DomainIcon sx={{ fontSize: 32, color: alpha(T.accent, 0.3) }} />
                      </Box>
                      <Typography sx={{ fontSize: '0.9rem', fontWeight: 600, color: T.muted, mb: 0.5 }}>{data.length === 0 ? 'No assignments yet' : 'No departments match your search'}</Typography>
                      <Typography sx={{ fontSize: '0.78rem', color: T.faint }}>{data.length === 0 ? 'Use the form on the left to assign employees.' : 'Try a different search term.'}</Typography>
                    </Box>
                  ) : viewMode === 'grid' ? (
                    <Grid container spacing={1.5}>
                      {filteredDepartmentData.map((dept) => (
                        <Grid item xs={6} sm={4} md={2.4} key={dept.code}>
                          <DeptCard department={dept} onClick={() => handleOpenModal(dept)} />
                        </Grid>
                      ))}
                    </Grid>
                  ) : (
                    <>
                      <Box sx={{ px: 2, py: 1, display: 'grid', gridTemplateColumns: '1fr auto', gap: 1, alignItems: 'center', bgcolor: alpha(T.accent, 0.04), borderRadius: 1.5, mb: 1 }}>
                        {['Department', 'Employees'].map((col) => (
                          <Typography key={col} sx={{ fontSize: '0.65rem', fontWeight: 700, color: T.accent, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{col}</Typography>
                        ))}
                      </Box>
                      {filteredDepartmentData.map((dept, i) => <DeptRow key={dept.code} department={dept} index={i} onClick={() => handleOpenModal(dept)} />)}
                    </>
                  )}
                </Box>
              </SectionCard>
            </Grid>
          </Grid>

          {/* ══════════════════════════════════════════════════
              SPLIT-VIEW MODAL
          ══════════════════════════════════════════════════ */}
          <Modal
            open={modalOpen}
            onClose={handleCloseModal}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}
          >
            <Fade in={modalOpen}>
              <Box
                sx={{
                  width: '95%',
                  maxWidth: '1100px',
                  height: '85vh',
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: 3,
                  overflow: 'hidden',
                  boxShadow: '0 24px 64px rgba(0,0,0,0.22)',
                  outline: 'none',
                  bgcolor: T.surface,
                }}
              >
                {selectedDepartment && (
                  <>
                    {/* Header */}
                    <ModalHeader
                      title={selectedDepartment.description || selectedDepartment.code}
                      chips={[selectedDepartment.code]}
                      subtitle={`${selectedDepartment.employees.length} ${selectedDepartment.employees.length === 1 ? 'member' : 'members'}`}
                      onClose={handleCloseModal}
                    />

                    {/* Split Body */}
                    <Box sx={{ flexGrow: 1, display: 'flex', overflow: 'hidden', bgcolor: '#fff' }}>

                      {/* ── Left Panel: Member List ── */}
                      <Box
                        sx={{
                          width: 300,
                          borderRight: `1px solid ${T.divider}`,
                          display: 'flex',
                          flexDirection: 'column',
                          bgcolor: '#f9f9f9',
                        }}
                      >
                        <Box sx={{ p: 2, borderBottom: `1px solid ${T.divider}` }}>
                          <Typography sx={{ fontSize: '0.82rem', fontWeight: 700, color: T.text, mb: 1 }}>
                            Members
                          </Typography>
                          <FieldInput
                            size="small"
                            placeholder="Search members…"
                            value={modalMemberSearch}
                            onChange={(e) => setModalMemberSearch(e.target.value)}
                            fullWidth
                            InputProps={{ startAdornment: <SearchIcon sx={{ fontSize: 15, color: T.muted, mr: 0.5 }} /> }}
                          />
                        </Box>

                        <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 1, ...scrollbarSx }}>
                          {selectedDepartment.employees.length === 0 ? (
                            <Box sx={{ p: 3, textAlign: 'center' }}>
                              <Typography sx={{ fontSize: '0.82rem', color: T.faint, fontStyle: 'italic' }}>
                                No employees assigned.
                              </Typography>
                            </Box>
                          ) : filteredModalMembers.length === 0 ? (
                            <Box sx={{ p: 3, textAlign: 'center' }}>
                              <Typography sx={{ fontSize: '0.82rem', color: T.faint, fontStyle: 'italic' }}>
                                No matches found.
                              </Typography>
                            </Box>
                          ) : (
                            filteredModalMembers.map((emp) => {
                              const detail = deptEmpDetails[emp.employeeNumber];
                              const displayName = detail?.name || emp.name || 'Unknown';
                              const isSelected = editAssignment?.id === emp.id;
                              return (
                                <Box
                                  key={emp.id}
                                  onClick={async () => {
                                    setEditAssignment({ ...emp });
                                    setOriginalAssignment({ ...emp });
                                    setIsEditingModal(false);
                                    if (emp.employeeNumber) {
                                      try {
                                        const r = await axios.get(`${API_BASE_URL}/Remittance/employees/${emp.employeeNumber}`, getAuthHeaders());
                                        setSelectedEditEmployee(r.data);
                                      } catch { setSelectedEditEmployee(null); }
                                    }
                                  }}
                                  sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 1.5,
                                    px: 1.5,
                                    py: 1,
                                    borderRadius: 1.5,
                                    mb: 0.75,
                                    cursor: 'pointer',
                                    border: isSelected ? `1px solid ${T.accent}` : '1px solid transparent',
                                    bgcolor: isSelected ? alpha(T.accent, 0.07) : 'transparent',
                                    transition: 'all 0.13s',
                                    '&:hover': { bgcolor: isSelected ? alpha(T.accent, 0.1) : T.rowHover },
                                  }}
                                >
                                  <Avatar
                                    sx={{
                                      width: 30,
                                      height: 30,
                                      bgcolor: isSelected ? T.accent : 'rgba(0,0,0,0.1)',
                                      color: isSelected ? '#fff' : T.muted,
                                      fontSize: '0.72rem',
                                      fontWeight: 700,
                                      flexShrink: 0,
                                      transition: 'all 0.15s',
                                    }}
                                  >
                                    {displayName.charAt(0).toUpperCase()}
                                  </Avatar>
                                  <Box sx={{ minWidth: 0 }}>
                                    <Typography noWrap sx={{ fontSize: '0.82rem', fontWeight: 700, color: isSelected ? T.accent : T.text }}>
                                      {displayName}
                                    </Typography>
                                    <Typography sx={{ fontSize: '0.7rem', color: T.muted }}>
                                      #{emp.employeeNumber}
                                    </Typography>
                                  </Box>
                                </Box>
                              );
                            })
                          )}
                        </Box>
                      </Box>

                      {/* ── Right Panel: Detail / Edit Form ── */}
                      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        {editAssignment ? (
                          <>
                            {/* Fields */}
                            <Box sx={{ flexGrow: 1, overflowY: 'auto', ...scrollbarSx }}>

                              {/* ── Employee Hero Banner ── */}
                              <Box sx={{
                                px: 4, py: 3.5,
                                background: 'linear-gradient(135deg, #fdf5f5 0%, #f0dede 100%)',
                                borderBottom: `1px solid ${T.accentBorder}`,
                                display: 'flex', alignItems: 'center', gap: 3,
                                position: 'relative', overflow: 'hidden',
                              }}>
                                <Box sx={{ position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%', background: 'radial-gradient(circle, rgba(109,35,35,0.08) 0%, transparent 70%)' }} />
                                <Avatar sx={{
                                  width: 64, height: 64,
                                  bgcolor: T.accent, color: '#fff',
                                  fontSize: '1.5rem', fontWeight: 700,
                                  flexShrink: 0,
                                  boxShadow: `0 4px 16px ${alpha(T.accent, 0.28)}`,
                                }}>
                                  {(selectedEditEmployee?.name || editAssignment.name || '?').charAt(0).toUpperCase()}
                                </Avatar>
                                <Box sx={{ flex: 1, minWidth: 0, position: 'relative', zIndex: 1 }}>
                                  <Typography sx={{ fontSize: '1.1rem', fontWeight: 800, color: T.accent, lineHeight: 1.2, mb: 0.4 }} noWrap>
                                    {selectedEditEmployee?.name || editAssignment.name || 'Unknown'}
                                  </Typography>
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                    <Chip
                                      label={`#${editAssignment.employeeNumber}`}
                                      size="small"
                                      icon={<PersonIcon sx={{ fontSize: '11px !important', color: `${T.accent} !important` }} />}
                                      sx={{ height: 20, fontSize: '0.68rem', fontWeight: 700, bgcolor: alpha(T.accent, 0.1), color: T.accent, border: `1px solid ${alpha(T.accent, 0.2)}`, '& .MuiChip-label': { px: 0.75 } }}
                                    />
                                    {editAssignment.code && (
                                      <Chip
                                        label={editAssignment.code}
                                        size="small"
                                        icon={<DomainIcon sx={{ fontSize: '11px !important', color: `${T.accentMid} !important` }} />}
                                        sx={{ height: 20, fontSize: '0.68rem', fontWeight: 700, bgcolor: alpha(T.accent, 0.06), color: T.accentMid, border: `1px solid ${alpha(T.accent, 0.15)}`, '& .MuiChip-label': { px: 0.75 } }}
                                      />
                                    )}
                                    {editAssignment.budgetCode && (
                                      <Chip
                                        label={`Budget: ${editAssignment.budgetCode}`}
                                        size="small"
                                        icon={<DomainIcon sx={{ fontSize: '11px !important', color: '#8a6100 !important' }} />}
                                        sx={{ height: 20, fontSize: '0.68rem', fontWeight: 700, bgcolor: alpha('#b8860b', 0.1), color: '#8a6100', border: `1px solid ${alpha('#b8860b', 0.28)}`, '& .MuiChip-label': { px: 0.75 } }}
                                      />
                                    )}
                                  </Box>
                                </Box>
                              </Box>

                              {/* ── Info Sections ── */}
                              <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', gap: 3.5 }}>

                                {/* Department Code field */}
                                <Box>
                                  <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: alpha(T.accent, 0.5), textTransform: 'uppercase', letterSpacing: '0.1em', mb: 1.25 }}>
                                    Department Code
                                  </Typography>
                                  {isEditingModal ? (
                                    <Box>
                                      <DeptCodeAutocomplete
                                        value={editAssignment.code || ''}
                                        onChange={(val) => setEditAssignment((p) => ({ ...p, code: val }))}
                                        departmentList={departmentList}
                                      />
                                      {editAssignment.code && departmentList.find((d) => d.code === editAssignment.code)?.description && (
                                        <Typography sx={{ fontSize: '0.72rem', color: T.muted, mt: 0.5, ml: 0.5 }}>
                                          {departmentList.find((d) => d.code === editAssignment.code).description}
                                        </Typography>
                                      )}
                                    </Box>
                                  ) : (
                                    <Box sx={{
                                      p: '14px 18px', borderRadius: 2,
                                      bgcolor: T.accentFaint,
                                      border: `1px solid ${T.accentBorder}`,
                                      display: 'flex', alignItems: 'center', gap: 2,
                                    }}>
                                      <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: alpha(T.accent, 0.12), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <DomainIcon sx={{ fontSize: 18, color: T.accent }} />
                                      </Box>
                                      <Box>
                                        <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: T.accent, lineHeight: 1.2 }}>
                                          {editAssignment.code || 'N/A'}
                                        </Typography>
                                        {departmentList.find((d) => d.code === editAssignment.code)?.description && (
                                          <Typography sx={{ fontSize: '0.78rem', color: T.accentMid, mt: 0.2 }}>
                                            {departmentList.find((d) => d.code === editAssignment.code).description}
                                          </Typography>
                                        )}
                                      </Box>
                                    </Box>
                                  )}
                                </Box>

                                {/* Budget Department field */}
                                <Box>
                                  <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: alpha(T.accent, 0.5), textTransform: 'uppercase', letterSpacing: '0.1em', mb: 1.25 }}>
                                    Budget Department (Payroll Charge)
                                  </Typography>
                                  {isEditingModal ? (
                                    <Box>
                                      <BudgetCodeAutocomplete
                                        value={editAssignment.budgetCode || ''}
                                        onChange={(val) => setEditAssignment((p) => ({ ...p, budgetCode: val }))}
                                        allowedDepartments={appendix33DeptScopes}
                                        scopesLoaded={appendix33ScopesLoaded}
                                        scopesLoading={appendix33ScopesLoading}
                                        scopesError={appendix33ScopesError}
                                        placeholder="Same as department…"
                                      />
                                       {getBudgetScopeWarning(editAssignment.budgetCode) && (
                                         <Typography sx={{ fontSize: '0.7rem', color: '#b45309', mt: 0.75, ml: 0.5 }}>
                                           {getBudgetScopeWarning(editAssignment.budgetCode)}
                                         </Typography>
                                       )}
                                       <Typography sx={{ fontSize: '0.7rem', color: T.muted, mt: 0.75, ml: 0.5 }}>
                                         Optional. Routes this employee's pay to another department's tab in the exported payroll workbook. Their department above stays unchanged. Only departments enabled in the Appendix 33 layout are available here. Leave blank to use the department directly.
                                       </Typography>
                                    </Box>
                                  ) : (
                                    <Box sx={{
                                      p: '14px 18px', borderRadius: 2,
                                      bgcolor: editAssignment.budgetCode ? alpha('#b8860b', 0.05) : '#fafafa',
                                      border: `1px solid ${editAssignment.budgetCode ? alpha('#b8860b', 0.25) : T.divider}`,
                                      display: 'flex', alignItems: 'center', gap: 2,
                                    }}>
                                      <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: alpha('#b8860b', 0.1), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <DomainIcon sx={{ fontSize: 18, color: '#8a6100' }} />
                                      </Box>
                                      <Box>
                                        <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: editAssignment.budgetCode ? '#8a6100' : T.muted, lineHeight: 1.2 }}>
                                          {editAssignment.budgetCode || 'Same as department'}
                                        </Typography>
                                        <Typography sx={{ fontSize: '0.75rem', color: T.muted, mt: 0.2 }}>
                                          {editAssignment.budgetCode ? 'Pay is charged to this department in the exported payroll' : 'No budget override — uses the department above'}
                                        </Typography>
                                      </Box>
                                      {getBudgetScopeWarning(editAssignment.budgetCode) && (
                                        <Typography sx={{ fontSize: '0.75rem', color: '#b45309', mt: 0.75 }}>
                                          {getBudgetScopeWarning(editAssignment.budgetCode)}
                                        </Typography>
                                      )}
                                    </Box>
                                  )}
                                </Box>

                                {/* Employee field */}
                                <Box>
                                  <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: alpha(T.accent, 0.5), textTransform: 'uppercase', letterSpacing: '0.1em', mb: 1.25 }}>
                                    Employee
                                  </Typography>
                                  {isEditingModal ? (
                                    <Box>
                                      <SingleEmployeeAutocomplete
                                        value={editAssignment.employeeNumber || ''}
                                        onChange={(num) => setEditAssignment((p) => ({ ...p, employeeNumber: num }))}
                                        selectedEmployee={selectedEditEmployee}
                                        onEmployeeSelect={setSelectedEditEmployee}
                                      />
                                      {selectedEditEmployee && (
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 1.5, p: '10px 14px', borderRadius: 2, border: `1px solid ${alpha(T.accent, 0.25)}`, bgcolor: T.accentFaint }}>
                                          <Avatar sx={{ width: 32, height: 32, bgcolor: T.accent, color: '#fff', fontSize: '0.75rem', fontWeight: 700 }}>
                                            {selectedEditEmployee.name?.charAt(0)?.toUpperCase() || '?'}
                                          </Avatar>
                                          <Box sx={{ flex: 1, minWidth: 0 }}>
                                            <Typography noWrap sx={{ fontSize: '0.83rem', fontWeight: 700, color: T.text }}>{selectedEditEmployee.name}</Typography>
                                            <Typography sx={{ fontSize: '0.7rem', color: T.muted }}>#{editAssignment.employeeNumber}</Typography>
                                          </Box>
                                          <IconButton size="small" onClick={() => { setSelectedEditEmployee(null); setEditAssignment((p) => ({ ...p, employeeNumber: '' })); }} sx={{ color: '#c62828', width: 22, height: 22 }}>
                                            <Close sx={{ fontSize: 12 }} />
                                          </IconButton>
                                        </Box>
                                      )}
                                    </Box>
                                  ) : (
                                    <Box sx={{
                                      p: '14px 18px', borderRadius: 2,
                                      bgcolor: '#fafafa',
                                      border: `1px solid ${T.divider}`,
                                      display: 'flex', alignItems: 'center', gap: 2,
                                    }}>
                                      <Avatar sx={{ width: 42, height: 42, bgcolor: T.accent, color: '#fff', fontSize: '0.9rem', fontWeight: 700, flexShrink: 0 }}>
                                        {(selectedEditEmployee?.name || editAssignment.name || '?').charAt(0).toUpperCase()}
                                      </Avatar>
                                      <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography noWrap sx={{ fontSize: '0.95rem', fontWeight: 700, color: T.text, lineHeight: 1.2 }}>
                                          {selectedEditEmployee?.name || editAssignment.name || 'Unknown'}
                                        </Typography>
                                        <Typography sx={{ fontSize: '0.75rem', color: T.muted, mt: 0.25 }}>
                                          Employee #{editAssignment.employeeNumber}
                                        </Typography>
                                      </Box>
                                    </Box>
                                  )}
                                </Box>

                              </Box>
                            </Box>

                            {/* Footer Actions */}
                            <Box sx={{
                              px: 4, py: 2.5,
                              borderTop: `1px solid ${T.divider}`,
                              display: 'flex',
                              justifyContent: 'flex-end',
                              alignItems: 'center',
                              gap: 1.5,
                              bgcolor: '#fafafa',
                            }}>
                              {isEditingModal ? (
                                <>
                                  <AccentButton
                                    onClick={() => { setIsEditingModal(false); setEditAssignment({ ...originalAssignment }); setSelectedEditEmployee(null); }}
                                    variant="outlined"
                                    startIcon={<CancelIcon sx={{ fontSize: '14px !important' }} />}
                                    sx={{ fontSize: '0.8rem', borderColor: T.accentBorder, color: T.muted, '&:hover': { bgcolor: T.accentFaint, borderColor: T.accent, color: T.accent, transform: 'none' } }}
                                  >
                                    Cancel
                                  </AccentButton>
                                  <AccentButton
                                    onClick={handleUpdate}
                                    variant="contained"
                                    startIcon={<SaveIcon sx={{ fontSize: '14px !important' }} />}
                                    disabled={!hasChanges() || !isBudgetCodeAllowed(editAssignment.budgetCode)}
                                    sx={{ fontSize: '0.8rem', bgcolor: '#639922', color: '#fff', boxShadow: '0 2px 10px rgba(99,153,34,0.32)', '&:hover': { bgcolor: '#3B6D11' }, '&:disabled': { bgcolor: '#b9c7a5 !important', color: '#fff !important' } }}
                                  >
                                    Save Changes
                                  </AccentButton>
                                </>
                              ) : (
                                <>
                                  <AccentButton
                                    onClick={() => setIsEditingModal(true)}
                                    variant="contained"
                                    startIcon={<EditIcon sx={{ fontSize: '14px !important' }} />}
                                    sx={{ fontSize: '0.8rem', bgcolor: T.accent, color: '#fff', boxShadow: `0 2px 10px ${alpha(T.accent, 0.32)}`, '&:hover': { bgcolor: T.accentDark } }}
                                  >
                                    Edit
                                  </AccentButton>
                                  <AccentButton
                                    onClick={() => handleDelete(editAssignment.id)}
                                    variant="outlined"
                                    startIcon={<DeleteIcon sx={{ fontSize: '14px !important' }} />}
                                    sx={{ fontSize: '0.8rem', borderColor: '#e57373', color: '#c62828', '&:hover': { bgcolor: 'rgba(198,40,40,0.06)', borderColor: '#c62828', transform: 'none' } }}
                                  >
                                    Delete
                                  </AccentButton>
                                </>
                              )}
                            </Box>
                          </>
                        ) : (
                          <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5, p: 4 }}>
                            <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: T.accentFaint, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <PersonIcon sx={{ fontSize: 26, color: alpha(T.accent, 0.3) }} />
                            </Box>
                            <Typography sx={{ fontSize: '0.9rem', fontWeight: 600, color: T.muted }}>No member selected</Typography>
                            <Typography sx={{ fontSize: '0.78rem', color: T.faint, textAlign: 'center' }}>
                              Select a member from the list to view their assignment details.
                            </Typography>
                          </Box>
                        )}
                      </Box>
                    </Box>
                  </>
                )}
              </Box>
              
            </Fade>
          </Modal>

          <LoadingOverlay open={loading} message="Processing assignment…" />
          <SuccessfulOverlay
            open={successOpen}
            action={successAction}
            onClose={() => setSuccessOpen(false)}
          />

          <Snackbar open={snackbar.open} autoHideDuration={3000} onClose={() => setSnackbar({ ...snackbar, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}>
            <Alert onClose={() => setSnackbar({ ...snackbar, open: false })} severity={snackbar.severity} sx={{ width: '100%', borderRadius: 2 }}>{snackbar.message}</Alert>
          </Snackbar>
        </Box>
      </Fade>
    </>
  );
};

export default DepartmentAssignment;