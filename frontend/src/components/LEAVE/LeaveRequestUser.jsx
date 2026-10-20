import API_BASE_URL from "../../apiConfig";
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Button,
  Avatar,
  Chip,
  Card,
  Fade,
  Grid,
  FormControl,
  Tooltip,
  IconButton,
  Backdrop,
  Snackbar,
  Modal,
  styled,
  alpha,
  Divider,
  Select,
  MenuItem,
  TextField,
  CardContent,
} from "@mui/material";
import {
  EventNote,
  FilterList as FilterIcon,
  EventAvailable as ReorderIcon,
  Person as PersonIcon,
  CalendarMonth as CalendarIcon,
  Refresh,
  AccessTime,
  WorkHistory as SCIcon,
  CheckCircle,
  Block,
  Cancel as CancelIcon,
  Schedule as ScheduleIcon,
  Add as AddIcon,
  WarningAmber as WarningIcon,
  AccountBalanceWallet as WalletIcon,
  HistoryToggleOff,
  Close,
  KeyboardArrowUp,
  Delete as DeleteIcon,
  ErrorOutline as ErrorOutlineIcon,
  HelpOutline as HelpOutlineIcon,
  Lock as LockIcon,
  TableRows as TableRowsIcon,
  Visibility as VisibilityIcon,
  Description as FileTextIcon,
  Badge as BadgeCheckIcon,
  Label as TagIcon,
  EventNote as CalendarEventIcon,
  InfoOutlined as InfoCircleIcon,
  Send as SendIcon,
  ManageSearch as ManageSearchIcon,
  FilterAlt as FilterAltIcon,
  NavigateBefore,
  NavigateNext,
  Work as WorkIcon,
  BeachAccess as BeachIcon,
  Favorite as HeartIcon,
  CardGiftcard as GiftIcon,
  PregnantWoman as MaternityIcon,
  ListAlt as ListAltIcon,
  MenuBook as LedgerIcon,
  Search as SearchIcon,
  FamilyRestroom as AdoptionIcon,
  MedicalServices as RehabIcon,
  School as StudyIcon,
  SelfImprovement as WellnessIcon,
  EscalatorWarning as SoloParentIcon,
} from "@mui/icons-material";
import axios from "axios";
import { getAuthHeaders } from "../../utils/auth";
import { useSocket } from "../../contexts/SocketContext";
import { jwtDecode } from "jwt-decode";

import usePageAccess from "../../hooks/usePageAccess";
import AccessDenied from "../AccessDenied";
import SuccessfulOverlay from "../SuccessfulOverlay";
import LeaveDatePicker from "./LeaveDatePicker";
import { useSystemSettings } from "../../hooks/useSystemSettings";
import { getLeaveTypeStatsActive } from "./leaveAssignmentBalanceUtils";

// ─── Theme tokens ──────────────────────────────────────────────────────────────
const T = {
  accent: "#6d2323",
  accentDark: "#5a1d1d",
  accentMid: "#8B4545",
  accentFaint: "rgba(109,35,35,0.06)",
  accentBorder: "rgba(109,35,35,0.14)",
  accentHover: "rgba(109,35,35,0.10)",
  headerGrad: "linear-gradient(180deg,#6d2323 0%,#7e2c2c 100%)",
  rowEven: "#ffffff",
  rowOdd: "rgba(109,35,35,0.025)",
  rowHover: "rgba(109,35,35,0.055)",
  text: "#1a1a1a",
  muted: "#6b6b6b",
  faint: "#a0a0a0",
  surface: "#ffffff",
  divider: "rgba(0,0,0,0.08)",
};

// ─── Balance card icon + color palette (matches per-leave-type accent, not the app accent) ─
const BALANCE_STYLES = [
  { match: (c, d) => /^vl$|vac/i.test(c) || /vacation/i.test(d), icon: BeachIcon, color: "#2E7D32", bg: "#E8F5E9" },
  { match: (c, d) => /^sl$|sick/i.test(c) || /sick/i.test(d), icon: HeartIcon, color: "#C62828", bg: "#FFEBEE" },
  { match: (c, d) => /mat/i.test(c) || /maternity/i.test(d), icon: MaternityIcon, color: "#6B5CA5", bg: "#EFEBF7" },
  { match: (c, d) => /adopt/i.test(c) || /adoption/i.test(d), icon: AdoptionIcon, color: "#8D6E63", bg: "#EFEBE9" },
  { match: (c, d) => /rehab/i.test(c) || /rehabilitation/i.test(d), icon: RehabIcon, color: "#00838F", bg: "#E0F7FA" },
  { match: (c, d) => /solo/i.test(c) || /solo parent/i.test(d), icon: SoloParentIcon, color: "#1565C0", bg: "#E3F2FD" },
  { match: (c, d) => /calam|emerg|special/i.test(c) || /calamity|emergency|special leave/i.test(d), icon: WarningIcon, color: "#EF6C00", bg: "#FFF3E0" },
  { match: (c, d) => /mand|force/i.test(c) || /mandatory|forced/i.test(d), icon: WorkIcon, color: "#5D4037", bg: "#D7CCC8" },
  { match: (c, d) => /stud/i.test(c) || /study/i.test(d), icon: StudyIcon, color: "#4527A0", bg: "#EDE7F6" },
  { match: (c, d) => /wellness/i.test(c) || /wellness/i.test(d), icon: WellnessIcon, color: "#00695C", bg: "#E0F2F1" },
  { match: (c, d) => /priv/i.test(c) || /privilege/i.test(d), icon: GiftIcon, color: "#AD1457", bg: "#FCE4EC" },
  { match: (c) => /^sc$/i.test(c), icon: SCIcon, color: "#0277BD", bg: "#E1F5FE" },
  { match: (c) => /^cto$/i.test(c), icon: HistoryToggleOff, color: "#455A64", bg: "#ECEFF1" },
];
const getBalanceStyle = (code, desc) => {
  const c = String(code || "").trim();
  const d = String(desc || "").trim();
  const found = BALANCE_STYLES.find((s) => s.match(c, d));
  return found || { icon: TagIcon, color: T.accent, bg: T.accentFaint };
};

const TX_LOGS_PER_PAGE = 5;
const REQ_LOGS_PER_PAGE = 4;

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ─── Styled primitives ─────────────────────────────────────────────────────────
const SectionCard = styled(Card)({
  borderRadius: 12,
  boxShadow: "0 1px 4px rgba(0,0,0,0.07), 0 4px 24px rgba(0,0,0,0.04)",
  border: "0.5px solid rgba(0,0,0,0.09)",
  overflow: "hidden",
  background: T.surface,
});

const FieldInput = styled(TextField)({
  "& .MuiOutlinedInput-root": {
    borderRadius: 8,
    fontSize: "0.875rem",
    backgroundColor: "#fff",
    "& fieldset": { borderColor: T.accentBorder },
    "&:hover fieldset": { borderColor: T.accent },
    "&.Mui-focused fieldset": { borderColor: T.accent, borderWidth: 1.5 },
    "& .MuiInputBase-input.Mui-disabled": { WebkitTextFillColor: T.text },
  },
  "& .MuiInputLabel-root.Mui-focused": { color: T.accent },
});

const AccentButton = styled(Button)({
  borderRadius: 8,
  textTransform: "none",
  fontWeight: 600,
  fontSize: "0.85rem",
  letterSpacing: "0.01em",
  transition: "all 0.18s ease",
  "&:hover": { transform: "translateY(-1px)" },
  "&:active": { transform: "translateY(0)" },
});

const ModernSelect = styled(Select)({
  borderRadius: 8,
  fontSize: "0.875rem",
  backgroundColor: "#fff",
  "& .MuiOutlinedInput-notchedOutline": { borderColor: T.accentBorder },
  "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: T.accent },
  "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
    borderColor: T.accent,
    borderWidth: "1.5px",
  },
});

// ─── Section label (matches LeaveRequest's form-section pattern) ──────────────
const FormSectionLabel = ({ icon: Icon, children }) => (
  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1.5 }}>
    <Icon sx={{ fontSize: 12, color: alpha(T.accent, 0.45) }} />
    <Typography sx={{ fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: alpha(T.accent, 0.45) }}>
      {children}
    </Typography>
  </Box>
);

// ─── Shimmer ───────────────────────────────────────────────────────────────────
const shimmerKf = `
@keyframes lruShimmer {
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
}
@keyframes lruBlink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.55; }
}`;

const Bone = ({ w = "100%", h = 14, r = 6, sx = {} }) => (
  <Box
    sx={{
      width: w,
      height: h,
      borderRadius: r,
      background: `linear-gradient(90deg, rgba(109,35,35,0.07) 25%, rgba(109,35,35,0.14) 50%, rgba(109,35,35,0.07) 75%)`,
      backgroundSize: "800px 100%",
      animation: "lruShimmer 1.6s infinite linear",
      flexShrink: 0,
      ...sx,
    }}
  />
);

const Wireframe = () => (
  <>
    <style>{shimmerKf}</style>
    <Box
      sx={{
        py: { xs: 2, md: 4 },
        mt: { xs: 0, md: -5 },
        width: "100vw",
        maxWidth: "100%",
        position: "relative",
        left: "49%",
        transform: "translateX(-48%)",
        px: { xs: 2, sm: 3, md: 6 },
      }}
    >
      <Box
        sx={{
          mb: 2,
          borderRadius: 3,
          overflow: "hidden",
          border: `1px solid ${T.accentBorder}`,
          animation: "lruBlink 2s ease-in-out infinite",
        }}
      >
        <Box
          sx={{
            p: 3.5,
            background: "linear-gradient(135deg,#fdf5f5 0%,#f0dede 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 2.5,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: "50%", bgcolor: "rgba(109,35,35,0.12)", flexShrink: 0 }} />
            <Box>
              <Bone w={200} h={16} sx={{ mb: 1 }} />
              <Bone w={280} h={10} />
            </Box>
          </Box>
          <Box sx={{ display: "flex", gap: 1.5 }}>
            <Bone w={140} h={30} r={8} />
            <Box sx={{ width: 32, height: 32, borderRadius: "50%", bgcolor: "rgba(109,35,35,0.1)" }} />
          </Box>
        </Box>
      </Box>
      <Box
        sx={{
          mb: 2,
          borderRadius: 3,
          border: `1px solid ${T.accentBorder}`,
          bgcolor: "#fff",
          overflow: "hidden",
          animation: "lruBlink 2s ease-in-out 0.07s infinite",
        }}
      >
        <Box sx={{ px: 3.5, py: 2, borderBottom: `1px solid ${T.divider}`, bgcolor: T.accentFaint }}>
          <Bone w={150} h={12} />
        </Box>
        <Box sx={{ p: 3, display: "flex", flexWrap: "wrap", gap: 1.5 }}>
          {[...Array(5)].map((_, i) => (
            <Box key={i} sx={{ width: 160, height: 52, borderRadius: 2, border: `1px solid ${T.accentBorder}`, bgcolor: "#fafafa" }} />
          ))}
        </Box>
      </Box>
      <Grid container spacing={2}>
        {[0, 1].map((col) => (
          <Grid item xs={12} lg={6} key={col}>
            <Box
              sx={{
                borderRadius: 3,
                border: `1px solid ${T.accentBorder}`,
                bgcolor: "#fff",
                overflow: "hidden",
                animation: `lruBlink 2s ease-in-out ${col * 0.1}s infinite`,
                height: "calc(100vh - 480px)",
              }}
            >
              <Box sx={{ px: 3.5, py: 2, borderBottom: `1px solid ${T.divider}`, bgcolor: T.accentFaint, display: "flex", alignItems: "center", gap: 1.5 }}>
                <Box sx={{ width: 24, height: 24, borderRadius: "50%", bgcolor: "rgba(109,35,35,0.12)" }} />
                <Bone w={160} h={12} />
              </Box>
              <Box sx={{ p: 3.5, display: "flex", flexDirection: "column", gap: 2.5 }}>
                {[100, 140, 110, 120, 100].map((w, i) => (
                  <Box key={i}>
                    <Bone w={w} h={10} sx={{ mb: 1 }} />
                    <Box sx={{ height: 38, borderRadius: 2, border: `1px solid ${T.accentBorder}`, bgcolor: "#fafafa" }} />
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

// ─── Status config ─────────────────────────────────────────────────────────────
const allStatusOptions = [
  { value: "0", label: "Pending", color: "#F57C00", bg: "#FFF3E0", icon: AccessTime },
  { value: "1", label: "Supervisor Approved", color: "#1565C0", bg: "#E3F2FD", icon: CheckCircle },
  { value: "2", label: "HR Approved", color: "#2E7D32", bg: "#E8F5E9", icon: CheckCircle },
  { value: "3", label: "Denied", color: "#C62828", bg: "#FFEBEE", icon: Block },
  { value: "4", label: "Cancelled", color: "#757575", bg: "#F5F5F5", icon: CancelIcon },
];

const selectSx = {
  borderRadius: "8px",
  fontSize: "0.875rem",
  bgcolor: "#fff",
  "& .MuiOutlinedInput-notchedOutline": { borderColor: T.accentBorder },
  "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: T.accent },
  "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: T.accent, borderWidth: "1.5px" },
};

// ─── Status pill ───────────────────────────────────────────────────────────────
const StatusPill = ({ status }) => {
  const opt = allStatusOptions.find((o) => o.value === String(status)) || allStatusOptions[0];
  const Icon = opt.icon;
  return (
    <Chip
      size="small"
      icon={<Icon style={{ fontSize: 11, color: opt.color }} />}
      label={opt.label}
      sx={{
        height: 22,
        fontSize: "0.72rem",
        fontWeight: 600,
        bgcolor: opt.bg,
        color: opt.color,
        border: `1px solid ${alpha(opt.color, 0.25)}`,
        borderRadius: "6px",
        "& .MuiChip-icon": { ml: "4px" },
      }}
    />
  );
};

// ─── Generic Confirm Modal ─────────────────────────────────────────────────────
const ConfirmModal = ({
  open, onClose, onConfirm, title, message,
  confirmLabel = "Confirm",
  confirmColor = T.accent, confirmHoverColor = T.accentDark,
  icon: Icon = HelpOutlineIcon, iconColor = T.accent, iconBg = T.accentFaint,
  loading = false,
}) => (
  <Modal open={open} onClose={onClose} sx={{ display: "flex", alignItems: "center", justifyContent: "center", p: 2, zIndex: 1400 }}>
    <Fade in={open}>
      <Box sx={{ width: "100%", maxWidth: 420, borderRadius: 3, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.22)", bgcolor: T.surface, display: "flex", flexDirection: "column" }}>
        <Box sx={{ px: 3.5, py: 2.5, background: T.headerGrad, display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", overflow: "hidden" }}>
          <Box sx={{ position: "absolute", top: -40, right: -30, width: 140, height: 140, borderRadius: "50%", bgcolor: "rgba(255,255,255,0.04)" }} />
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, position: "relative", zIndex: 1 }}>
            <Box sx={{ width: 36, height: 36, borderRadius: 2, bgcolor: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon sx={{ fontSize: 17, color: "#fff" }} />
            </Box>
            <Typography sx={{ fontWeight: 700, color: "#fff", fontSize: "0.93rem" }}>{title}</Typography>
          </Box>
          <IconButton onClick={onClose} size="small" sx={{ color: "rgba(255,255,255,0.75)", position: "relative", zIndex: 1, "&:hover": { bgcolor: "rgba(255,255,255,0.12)" } }}>
            <Close sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
        <Box sx={{ px: 3.5, py: 3 }}>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: "50%", bgcolor: iconBg, border: `1px solid ${alpha(iconColor, 0.2)}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, mt: 0.25 }}>
              <Icon sx={{ fontSize: 18, color: iconColor }} />
            </Box>
            <Typography sx={{ fontSize: "0.875rem", color: T.text, lineHeight: 1.65, pt: 0.5, whiteSpace: "pre-line" }}>{message}</Typography>
          </Box>
        </Box>
        <Box sx={{ px: 3.5, py: 2, borderTop: `1px solid ${T.divider}`, bgcolor: "#f9f9f9", display: "flex", justifyContent: "flex-end", gap: 1.25 }}>
          <AccentButton onClick={onClose} variant="outlined" sx={{ fontSize: "0.8rem", borderColor: T.accentBorder, color: T.muted, "&:hover": { bgcolor: T.accentFaint, borderColor: T.accent, color: T.accent } }}>
            Cancel
          </AccentButton>
          <AccentButton onClick={onConfirm} variant="contained" disabled={loading} startIcon={loading ? <CircularProgress size={12} sx={{ color: "#fff" }} /> : null}
            sx={{ fontSize: "0.8rem", bgcolor: confirmColor, color: "#fff", "&:hover": { bgcolor: confirmHoverColor }, "&:disabled": { bgcolor: "#ddd" } }}>
            {loading ? "Processing…" : confirmLabel}
          </AccentButton>
        </Box>
      </Box>
    </Fade>
  </Modal>
);

// ─── Error Modal ───────────────────────────────────────────────────────────────
const ErrorModal = ({
  open, onClose, title, message,
  icon: Icon = ErrorOutlineIcon, iconColor = "#C62828", iconBg = "#FFEBEE",
}) => (
  <Modal open={open} onClose={onClose} sx={{ display: "flex", alignItems: "center", justifyContent: "center", p: 2, zIndex: 1500 }}>
    <Fade in={open}>
      <Box sx={{ width: "100%", maxWidth: 420, borderRadius: 3, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.22)", bgcolor: T.surface, display: "flex", flexDirection: "column" }}>
        <Box sx={{ px: 3.5, py: 2.5, background: `linear-gradient(180deg,${iconColor} 0%,${alpha(iconColor, 0.82)} 100%)`, display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", overflow: "hidden" }}>
          <Box sx={{ position: "absolute", top: -40, right: -30, width: 140, height: 140, borderRadius: "50%", bgcolor: "rgba(255,255,255,0.05)" }} />
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, position: "relative", zIndex: 1 }}>
            <Box sx={{ width: 36, height: 36, borderRadius: 2, bgcolor: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.22)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon sx={{ fontSize: 17, color: "#fff" }} />
            </Box>
            <Typography sx={{ fontWeight: 700, color: "#fff", fontSize: "0.93rem" }}>{title}</Typography>
          </Box>
          <IconButton onClick={onClose} size="small" sx={{ color: "rgba(255,255,255,0.75)", position: "relative", zIndex: 1, "&:hover": { bgcolor: "rgba(255,255,255,0.12)" } }}>
            <Close sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
        <Box sx={{ px: 3.5, py: 3 }}>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: "50%", bgcolor: iconBg, border: `1px solid ${alpha(iconColor, 0.2)}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, mt: 0.25 }}>
              <Icon sx={{ fontSize: 18, color: iconColor }} />
            </Box>
            <Typography sx={{ fontSize: "0.875rem", color: T.text, lineHeight: 1.65, pt: 0.5 }}>{message}</Typography>
          </Box>
        </Box>
        <Box sx={{ px: 3.5, py: 2, borderTop: `1px solid ${T.divider}`, bgcolor: "#f9f9f9", display: "flex", justifyContent: "flex-end" }}>
          <AccentButton onClick={onClose} variant="contained" sx={{ fontSize: "0.8rem", bgcolor: iconColor, color: "#fff", "&:hover": { bgcolor: alpha(iconColor, 0.85) } }}>
            Understood
          </AccentButton>
        </Box>
      </Box>
    </Fade>
  </Modal>
);

// ─── Review Modal ──────────────────────────────────────────────────────────────
const formatDateDisplay = (dateStr) => {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
};

const SummaryRow = ({ icon: Icon, label, children, highlight }) => (
  <Box
    sx={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      px: 1.75, py: 1,
      borderBottom: `1px solid ${T.divider}`,
      bgcolor: highlight ? "rgba(198,40,40,0.04)" : "transparent",
      "&:last-child": { borderBottom: "none" },
    }}
  >
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexShrink: 0 }}>
      <Icon sx={{ fontSize: 14, color: T.muted }} />
      <Typography sx={{ fontSize: "0.75rem", color: T.muted }}>{label}</Typography>
    </Box>
    <Box sx={{ textAlign: "right", maxWidth: 260 }}>{children}</Box>
  </Box>
);

const ReviewModal = ({
  open, onClose, onConfirm, loading = false,
  personID = "", userName = "",
  leaveCode = "", leaveDescription = "",
  selectedDates = [], reason = "",
  remainingDays = 0, allocatedDays = 0,
}) => {
  const requestedDays = selectedDates.length;
  const afterDeductionDays = remainingDays - requestedDays;

  return (
    <Modal
      open={open}
      onClose={loading ? undefined : onClose}
      sx={{ display: "flex", alignItems: "center", justifyContent: "center", p: 2, zIndex: 1400 }}
    >
      <Fade in={open}>
        <Box sx={{ width: "100%", maxWidth: 480, borderRadius: 3, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.22)", bgcolor: T.surface, display: "flex", flexDirection: "column" }}>

          {/* Header */}
          <Box sx={{ px: 3.5, py: 2.5, background: T.headerGrad, display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", overflow: "hidden" }}>
            <Box sx={{ position: "absolute", top: -40, right: -30, width: 140, height: 140, borderRadius: "50%", bgcolor: "rgba(255,255,255,0.04)", pointerEvents: "none" }} />
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, position: "relative", zIndex: 1 }}>
              <Box sx={{ width: 36, height: 36, borderRadius: 2, bgcolor: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.22)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CalendarEventIcon sx={{ fontSize: 17, color: "#fff" }} />
              </Box>
              <Box>
                <Typography sx={{ fontWeight: 700, color: "#fff", fontSize: "0.93rem", lineHeight: 1.2 }}>
                  Review & Submit Leave Request
                </Typography>
                <Typography sx={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.65)", mt: 0.25 }}>
                  Please review your request before submitting
                </Typography>
              </Box>
            </Box>
            <IconButton onClick={loading ? undefined : onClose} size="small" sx={{ color: "rgba(255,255,255,0.75)", position: "relative", zIndex: 1, "&:hover": { bgcolor: "rgba(255,255,255,0.12)" } }}>
              <Close sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>

          {/* Preview banner */}
          <Box sx={{ px: 2.5, py: 0.9, bgcolor: "#fff8e1", borderBottom: "1px solid #ffe082", display: "flex", alignItems: "center", gap: 1 }}>
            <VisibilityIcon sx={{ fontSize: 13, color: "#F57C00" }} />
            <Typography sx={{ fontSize: "0.72rem", color: "#795548", fontWeight: 600 }}>
              Preview — confirm the details below before submitting
            </Typography>
          </Box>

          {/* Body */}
          <Box sx={{ px: 3, py: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>

            {/* Summary card */}
            <Box sx={{ border: `1px solid ${T.accentBorder}`, borderRadius: 2, overflow: "hidden" }}>
              <Box sx={{ px: 1.75, py: 1, bgcolor: T.accentFaint, borderBottom: `1px solid ${T.accentBorder}`, display: "flex", alignItems: "center", gap: 0.75 }}>
                <FileTextIcon sx={{ fontSize: 13, color: T.accent }} />
                <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, color: T.accent }}>Request Summary</Typography>
              </Box>

              {/* Employee */}
              <SummaryRow icon={BadgeCheckIcon} label="Employee">
                <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: T.text }}>
                  {personID}{userName ? ` — ${userName}` : ""}
                </Typography>
              </SummaryRow>

              {/* Leave type */}
              <SummaryRow icon={TagIcon} label="Leave Type">
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, justifyContent: "flex-end" }}>
                  <Box sx={{ px: 0.85, py: 0.2, borderRadius: 1, bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}` }}>
                    <Typography sx={{ fontSize: "0.68rem", fontWeight: 800, color: T.accent }}>{leaveCode}</Typography>
                  </Box>
                  <Typography sx={{ fontSize: "0.8rem", color: T.text, fontWeight: 500 }}>{leaveDescription}</Typography>
                </Box>
              </SummaryRow>

              {/* Duration */}
              <SummaryRow icon={CalendarEventIcon} label="Duration">
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, justifyContent: "flex-end" }}>
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: T.text }}>
                    {requestedDays} day{requestedDays !== 1 ? "s" : ""}
                  </Typography>
                  <Chip
                    size="small"
                    icon={<AccessTime style={{ fontSize: 10, color: "#E65100" }} />}
                    label="Pending"
                    sx={{ height: 18, fontSize: "0.68rem", fontWeight: 600, bgcolor: "#FFF3E0", color: "#E65100", border: "1px solid rgba(230,81,0,0.22)", borderRadius: "4px", "& .MuiChip-icon": { ml: "3px" } }}
                  />
                </Box>
              </SummaryRow>

              {/* Dates */}
              <SummaryRow icon={CalendarIcon} label="Date(s)">
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, justifyContent: "flex-end", maxWidth: 260 }}>
                  {selectedDates.map((d) => (
                    <Box key={d} sx={{ px: 0.85, py: 0.3, borderRadius: 1, bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}` }}>
                      <Typography sx={{ fontSize: "0.7rem", fontWeight: 600, color: T.accent }}>{formatDateDisplay(d)}</Typography>
                    </Box>
                  ))}
                </Box>
              </SummaryRow>

              {/* Reason */}
              {reason && (
                <SummaryRow icon={FileTextIcon} label="Reason">
                  <Typography sx={{ fontSize: "0.8rem", color: T.text, fontStyle: "italic" }}>{reason}</Typography>
                </SummaryRow>
              )}

              {/* Balance (informational only — HR approves regardless of figures shown) */}
              <SummaryRow icon={WalletIcon} label="Leave balance (reference)">
                <Box>
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: T.text }}>
                    {remainingDays.toFixed(3)}d remaining · {allocatedDays.toFixed(3)}d allocated
                  </Typography>
                  <Typography sx={{ fontSize: "0.68rem", color: T.faint, mt: 0.25, lineHeight: 1.45 }}>
                    Approx. {afterDeductionDays.toFixed(3)}d after this request if deducted as shown. Final decision is with HR.
                  </Typography>
                </Box>
              </SummaryRow>
            </Box>

            {/* Info notice */}
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25, p: 1.5, bgcolor: "rgba(21,101,192,0.06)", border: "1px solid rgba(21,101,192,0.2)", borderRadius: 2 }}>
              <InfoCircleIcon sx={{ fontSize: 16, color: "#1565C0", flexShrink: 0, mt: 0.15 }} />
              <Typography sx={{ fontSize: "0.78rem", color: T.muted, lineHeight: 1.6 }}>
                Your request will be sent to your supervisor for approval. You can cancel it anytime while it is still{" "}
                <Box component="span" sx={{ fontWeight: 600, color: T.text }}>pending</Box>.
              </Typography>
            </Box>
          </Box>

          {/* Footer */}
          <Box sx={{ px: 3, py: 1.75, borderTop: `1px solid ${T.divider}`, bgcolor: "#f9f9f9", display: "flex", justifyContent: "flex-end", gap: 1.25 }}>
            <AccentButton
              onClick={loading ? undefined : onClose}
              variant="outlined"
              disabled={loading}
              sx={{ fontSize: "0.8rem", borderColor: T.accentBorder, color: T.muted, "&:hover": { bgcolor: T.accentFaint, borderColor: T.accent, color: T.accent } }}
            >
              Go Back
            </AccentButton>
            <AccentButton
              onClick={onConfirm}
              variant="contained"
              disabled={loading}
              startIcon={loading ? <CircularProgress size={12} sx={{ color: "#fff" }} /> : <SendIcon sx={{ fontSize: "14px !important" }} />}
              sx={{ fontSize: "0.8rem", bgcolor: T.accent, color: "#fff", "&:hover": { bgcolor: T.accentDark }, "&:disabled": { bgcolor: "#ddd" } }}
            >
              {loading ? "Submitting…" : "Submit Request"}
            </AccentButton>
          </Box>
        </Box>
      </Fade>
    </Modal>
  );
};

// ─── Main Component ────────────────────────────────────────────────────────────
const LeaveRequestUser = () => {
  const { hasAccess, loading: accessLoading } = usePageAccess("leave-request-user");
  const { socket, connected } = useSocket();
  const refreshRef = useRef(null);
  const fetchTransactionRef = useRef(null);
  const fetchAssignmentsRef = useRef(null);

  const [leaveRequests, setLeaveRequests] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [newLeaveRequest, setNewLeaveRequest] = useState({ leave_code: "", leave_date: "" });
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [successAction, setSuccessAction] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [leaveTypeFilter, setLeaveTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [reqSearchTerm, setReqSearchTerm] = useState("");
  const [reqPage, setReqPage] = useState(1);
  const [personID, setPersonID] = useState("");
  const [userName, setUserName] = useState("");
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const [transactionLogsModalOpen, setTransactionLogsModalOpen] = useState(false);
  const [transactionLogs, setTransactionLogs] = useState([]);
  const [transactionLogsLoading, setTransactionLogsLoading] = useState(false);
  const [transactionLogsError, setTransactionLogsError] = useState("");
  const [auditLogPage, setAuditLogPage] = useState(1);
  const [txSearchTerm, setTxSearchTerm] = useState("");
  const [txActionFilter, setTxActionFilter] = useState("all");
  const AUDIT_LOGS_PER_PAGE = TX_LOGS_PER_PAGE;
  const [selectedDates, setSelectedDates] = useState([]);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const initialLoadDone = useRef(false);
  const columnsRef = useRef(null);
  const [panelHeight, setPanelHeight] = useState(null);

  // ── Leave Balances horizontal scroll affordance ────────────────────────────
  const balancesScrollRef = useRef(null);
  const [balancesScroll, setBalancesScroll] = useState({ canLeft: false, canRight: false });

  const [scRemainingHours, setScRemainingHours] = useState(0);
  const [ctoRemainingHours, setCtoRemainingHours] = useState(0);

  const [errorModal, setErrorModal] = useState({
    open: false, title: "", message: "",
    iconColor: "#C62828", iconBg: "#FFEBEE", icon: ErrorOutlineIcon,
  });
  const [confirmModal, setConfirmModal] = useState({
    open: false, title: "", message: "",
    confirmLabel: "Confirm",
    confirmColor: T.accent, confirmHoverColor: T.accentDark,
    icon: HelpOutlineIcon, iconColor: T.accent, iconBg: T.accentFaint,
    loading: false, onConfirm: () => {},
  });

  // ── Leave ledger modal (read-only breakdown of balances) ──────────────────────
  const [ledgerModalOpen, setLedgerModalOpen] = useState(false);

  // ── Review modal state ────────────────────────────────────────────────────────
  const [reviewModal, setReviewModal] = useState({
    open: false,
    remainingDays: 0,
    allocatedDays: 0,
  });

  const showError = (title, message, opts = {}) =>
    setErrorModal({ open: true, title, message, iconColor: "#C62828", iconBg: "#FFEBEE", icon: ErrorOutlineIcon, ...opts });
  const closeError = () => setErrorModal((p) => ({ ...p, open: false }));
  const showConfirm = (opts) =>
    setConfirmModal({
      open: true, title: "", message: "", confirmLabel: "Confirm",
      confirmColor: T.accent, confirmHoverColor: T.accentDark,
      icon: HelpOutlineIcon, iconColor: T.accent, iconBg: T.accentFaint,
      loading: false, onConfirm: () => {}, ...opts,
    });
  const closeConfirm = () => setConfirmModal((p) => ({ ...p, open: false, loading: false }));

  const openReview = () => {
    const balance = groupedBalances.find((b) => b.code === newLeaveRequest.leave_code);
    const remainingDays = balance ? parseFloat(balance.totalDays) : 0;
    const allocatedDays = balance ? parseFloat(balance.allocatedDays) : 0;
    setReviewModal({ open: true, remainingDays, allocatedDays });
  };
  const closeReview = () => setReviewModal((p) => ({ ...p, open: false }));

  const { settings } = useSystemSettings();
  const accentColor = settings.primaryColor || T.accent;

  const isSickLeave = () => {
    const t = leaveTypes.find((x) => x.leave_code === newLeaveRequest.leave_code);
    if (!t) return false;
    return (
      (t.leave_code || "").toLowerCase().includes("sl") ||
      (t.leave_description || "").toLowerCase().includes("sick")
    );
  };

  const groupedBalances = useMemo(() => {
    const byCode = {};
    assignments.forEach((a) => {
      const code = a.leave_code;
      if (!byCode[code]) byCode[code] = [];
      byCode[code].push(a);
    });

    const result = Object.entries(byCode).map(([code, rows]) => {
      const stats = getLeaveTypeStatsActive(rows);
      const desc =
        leaveTypes.find((lt) => lt.leave_code === code)?.leave_description ||
        rows.find((r) => r.leave_description)?.leave_description ||
        code;
      return {
        code,
        description: desc,
        totalHours: stats.remainingHours,
        allocatedHours: stats.allocatedHours,
        totalDays: (stats.remainingHours / 8).toFixed(3),
        allocatedDays: (stats.allocatedHours / 8).toFixed(3),
      };
    });

    if (scRemainingHours > 1e-6) {
      result.push({
        code: "SC", description: "Service Credit",
        totalHours: scRemainingHours, allocatedHours: scRemainingHours,
        totalDays: (scRemainingHours / 8).toFixed(3),
        allocatedDays: (scRemainingHours / 8).toFixed(3),
      });
    }
    if (ctoRemainingHours > 1e-6) {
      result.push({
        code: "CTO", description: "Comp. Time Off",
        totalHours: ctoRemainingHours, allocatedHours: ctoRemainingHours,
        totalDays: (ctoRemainingHours / 8).toFixed(3),
        allocatedDays: (ctoRemainingHours / 8).toFixed(3),
      });
    }
    return result;
  }, [assignments, leaveTypes, scRemainingHours, ctoRemainingHours]);

  const months = [
    { value: "", label: "All Months" },
    { value: "01", label: "January" }, { value: "02", label: "February" },
    { value: "03", label: "March" }, { value: "04", label: "April" },
    { value: "05", label: "May" }, { value: "06", label: "June" },
    { value: "07", label: "July" }, { value: "08", label: "August" },
    { value: "09", label: "September" }, { value: "10", label: "October" },
    { value: "11", label: "November" }, { value: "12", label: "December" },
  ];

  const statusOptions = [
    { value: "", label: "All Status" },
    { value: "0", label: "Pending" },
    { value: "1", label: "Supervisor Approved" },
    { value: "2", label: "HR Approved" },
    { value: "3", label: "Denied" },
    { value: "4", label: "Cancelled" },
  ];

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      try {
        const decoded = jwtDecode(token);
        setPersonID(decoded.employeeNumber);
        const nameFromToken =
          decoded.fullName ||
          decoded.name ||
          [decoded.firstName, decoded.lastName].filter(Boolean).join(" ") || "";
        if (nameFromToken) setUserName(nameFromToken);
      } catch (e) { console.error(e); }
    }
  }, []);

  useEffect(() => {
    if (!personID || userName) return;
    const fetchName = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/personalinfo/person_table/${personID}`, getAuthHeaders());
        const name = [res.data.firstName, res.data.lastName].filter(Boolean).join(" ");
        if (name) setUserName(name);
      } catch (e) { console.error("Could not resolve user name", e); }
    };
    fetchName();
  }, [personID, userName]); // eslint-disable-line

  useEffect(() => {
    if (!personID || initialLoadDone.current) return;
    initialLoadDone.current = true;
    const init = async () => {
      await Promise.allSettled([fetchLeaveRequests(), fetchLeaveTypes(), fetchAssignments()]);
      setTimeout(() => setPageLoading(false), 350);
    };
    init();
  }, [personID]); // eslint-disable-line

  useEffect(() => {
    if (!personID) return;
    const fetchCreditBalances = async () => {
      try {
        const headers = getAuthHeaders();
        const [scRes, ctoRes] = await Promise.allSettled([
          axios.get(`${API_BASE_URL}/api/earnings/sc/${personID}/balance`, headers),
          axios.get(`${API_BASE_URL}/api/earnings/cto/${personID}/balance`, headers),
        ]);
        setScRemainingHours(scRes.status === "fulfilled" ? toNum(scRes.value?.data?.totalRemaining) : 0);
        setCtoRemainingHours(ctoRes.status === "fulfilled" ? toNum(ctoRes.value?.data?.totalRemaining) : 0);
      } catch {
        setScRemainingHours(0);
        setCtoRemainingHours(0);
      }
    };
    fetchCreditBalances();
  }, [personID]);

  useEffect(() => { refreshRef.current = fetchLeaveRequests; });
  useEffect(() => { fetchTransactionRef.current = fetchTransactionLogs; });
  useEffect(() => { fetchAssignmentsRef.current = fetchAssignments; });

  useEffect(() => {
    if (!socket || !connected) return;
    const handleReq = () => { refreshRef.current?.(); fetchAssignmentsRef.current?.(); fetchTransactionRef.current?.(); };
    const handleAssign = () => { fetchAssignmentsRef.current?.(); refreshRef.current?.(); fetchTransactionRef.current?.(); };
    socket.on("leaveRequestChanged", handleReq);
    socket.on("leaveAssignmentChanged", handleAssign);
    return () => { socket.off("leaveRequestChanged", handleReq); socket.off("leaveAssignmentChanged", handleAssign); };
  }, [socket, connected]);

  useEffect(() => {
    const handleScroll = () => setShowScrollTop(window.scrollY > 300);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // ── Leave Balances scroll affordance: detect overflow so arrow buttons +
  // fade edges only show up when there's actually more content to see. ──────
  const updateBalancesScroll = () => {
    const el = balancesScrollRef.current;
    if (!el) return;
    setBalancesScroll({
      canLeft: el.scrollLeft > 4,
      canRight: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  };

  useEffect(() => {
    updateBalancesScroll();
    window.addEventListener("resize", updateBalancesScroll);
    return () => window.removeEventListener("resize", updateBalancesScroll);
  }, [groupedBalances.length]); // eslint-disable-line

  const scrollBalances = (dir) => {
    const el = balancesScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.7), behavior: "smooth" });
  };

  // Measure real remaining space below the two-column section instead of guessing
  // a fixed viewport offset. This reacts to browser zoom (which fires 'resize')
  // and to real content height (header + balances), so it won't drift out of sync
  // like a hardcoded calc(100vh - Npx) does. FOOTER_CLEARANCE is the one number
  // you may need to tune — set it to your app's fixed footer height plus a small
  // breathing-room margin (e.g. 56px footer + 24px margin = 80).
  useEffect(() => {
    const FOOTER_CLEARANCE = 80;
    const MIN_PANEL_HEIGHT = 380;

    const updatePanelHeight = () => {
      if (!columnsRef.current) return;
      if (window.innerWidth < 1200) {
        setPanelHeight(null); // let mobile/tablet layouts size naturally
        return;
      }
      const top = columnsRef.current.getBoundingClientRect().top;
      const available = window.innerHeight - top - FOOTER_CLEARANCE;
      setPanelHeight(Math.max(MIN_PANEL_HEIGHT, Math.round(available)));
    };

    updatePanelHeight();
    window.addEventListener("resize", updatePanelHeight);
    return () => window.removeEventListener("resize", updatePanelHeight);
  }, [pageLoading, groupedBalances.length]);

  const fetchLeaveRequests = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/leaveRoute/leave_request/${personID}`, getAuthHeaders());
      setLeaveRequests(res.data);
    } catch (e) { console.error(e); }
  };
  const fetchLeaveTypes = async () => {
    try {
      // Staff-safe list (admin-only /leave_table 403s for staff), filtered server-side.
      const res = await axios.get(`${API_BASE_URL}/api/me/leave-types`, getAuthHeaders());
      setLeaveTypes(res.data);
    } catch (e) { console.error(e); }
  };
  const fetchAssignments = async () => {
    if (!personID) return;
    try {
      const res = await axios.get(
        `${API_BASE_URL}/leaveRoute/leave_assignment/employee/${personID}`,
        getAuthHeaders(),
      );
      setAssignments(Array.isArray(res.data) ? res.data : []);
    } catch (e) { console.error(e); }
  };
  const fetchTransactionLogs = async () => {
    if (!personID) return;
    setTransactionLogsLoading(true);
    setTransactionLogsError("");
    try {
      const res = await axios.get(`${API_BASE_URL}/leaveRoute/leave_request/transactions/${personID}`, getAuthHeaders());
      setTransactionLogs(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      console.error(e);
      setTransactionLogsError("Failed to load transaction logs.");
      setTransactionLogs([]);
    } finally {
      setTransactionLogsLoading(false);
    }
  };

  useEffect(() => {
    if (transactionLogsModalOpen) fetchTransactionLogs();
  }, [transactionLogsModalOpen, personID]); // eslint-disable-line

  // ── Validation only — opens review modal ─────────────────────────────────────
  const handleAdd = async () => {
    if (!newLeaveRequest.leave_code) {
      showError("Missing Fields", "Please select a leave type.", { icon: WarningIcon, iconColor: "#F57C00", iconBg: "#FFF3E0" });
      return;
    }
    if (!selectedDates.length) {
      showError("Missing Fields", "Please pick at least one leave date.", { icon: WarningIcon, iconColor: "#F57C00", iconBg: "#FFF3E0" });
      return;
    }
    const unavailableDates = selectedDates.filter((date) =>
      leaveRequests.some((req) => {
        const reqDates = (req.leave_date || "").split(",").map((s) => s.trim());
        return reqDates.includes(date) && String(req.status) === "2";
      })
    );
    if (unavailableDates.length > 0) {
      showError("Unavailable Dates", "One or more selected dates conflict with existing HR-approved leave.");
      return;
    }
    openReview();
  };

  // ── Actual API submission — called by ReviewModal ─────────────────────────────
  const handleSubmitConfirmed = async () => {
    setLoading(true);
    try {
      await axios.post(
        `${API_BASE_URL}/leaveRoute/leave_request`,
        {
          employeeNumber: personID,
          leave_code: newLeaveRequest.leave_code,
          leave_dates: selectedDates,
          reason,
          status: "0",
        },
        getAuthHeaders(),
      );
      setSuccessAction("Leave Request Submitted Successfully");
      setSuccessOpen(true);
      setTimeout(() => setSuccessOpen(false), 2000);
      await fetchLeaveRequests();
      await fetchAssignments();
      setNewLeaveRequest({ leave_code: "", leave_date: "" });
      setSelectedDates([]);
      setReason("");
      closeReview();
    } catch (err) {
      closeReview();
      showError("Submission Failed", err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancelRequest = async (id) => {
    showConfirm({
      title: "Cancel Leave Request",
      message: "Are you sure you want to cancel this leave request? This action cannot be undone.",
      confirmLabel: "Cancel Request",
      confirmColor: "#C62828", confirmHoverColor: "#B71C1C",
      icon: CancelIcon, iconColor: "#C62828", iconBg: "#FFEBEE",
      onConfirm: async () => {
        setConfirmModal((p) => ({ ...p, loading: true }));
        try {
          const req = leaveRequests.find((r) => r.id === id);
          await axios.put(
            `${API_BASE_URL}/leaveRoute/leave_request/${id}`,
            { employeeNumber: req.employeeNumber, leave_code: req.leave_code, leave_date: req.leave_date, status: 4 },
            getAuthHeaders(),
          );
          setSuccessAction("Request Cancelled Successfully");
          setSuccessOpen(true);
          setTimeout(() => setSuccessOpen(false), 2000);
          await fetchLeaveRequests();
          await fetchAssignments();
        } catch (err) {
          showError("Error", err.response?.data?.error || err.message);
        } finally {
          closeConfirm();
        }
      },
    });
  };

  const filteredLeaveRequests = useMemo(() => {
    const search = reqSearchTerm.toLowerCase().trim();
    return leaveRequests
      .filter((request) => {
        if (monthFilter) {
          const m = String(new Date(request.leave_date).getMonth() + 1).padStart(2, "0");
          if (m !== monthFilter) return false;
        }
        if (leaveTypeFilter && request.leave_code !== leaveTypeFilter) return false;
        if (statusFilter && String(request.status) !== statusFilter) return false;
        if (search) {
          const desc = (leaveTypes.find((t) => t.leave_code === request.leave_code)?.leave_description || "").toLowerCase();
          const code = (request.leave_code || "").toLowerCase();
          if (!desc.includes(search) && !code.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.leave_date) - new Date(a.leave_date));
  }, [leaveRequests, monthFilter, leaveTypeFilter, statusFilter, reqSearchTerm, leaveTypes]);

  const clearRequestFilters = () => {
    setMonthFilter("");
    setLeaveTypeFilter("");
    setStatusFilter("");
    setReqSearchTerm("");
  };

  useEffect(() => { setReqPage(1); }, [monthFilter, leaveTypeFilter, statusFilter, reqSearchTerm]);

  const reqTotalPages = Math.max(1, Math.ceil(filteredLeaveRequests.length / REQ_LOGS_PER_PAGE));
  useEffect(() => { if (reqPage > reqTotalPages) setReqPage(reqTotalPages); }, [reqPage, reqTotalPages]);
  const paginatedLeaveRequests = filteredLeaveRequests.slice(
    (reqPage - 1) * REQ_LOGS_PER_PAGE,
    reqPage * REQ_LOGS_PER_PAGE,
  );

  const formatDate = (d) => {
    if (!d) return "N/A";
    const s = Array.isArray(d) ? d[0] : d.split(",")[0].trim();
    const [y, m, day] = s.split("-");
    return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  // Renders a compact range like "Jun 9 – Jun 15, 2026 (5 days)" from a
  // comma-separated leave_date field, falling back gracefully for a single date.
  const formatDateRange = (d) => {
    if (!d) return { range: "N/A", count: 0 };
    const parts = (Array.isArray(d) ? d : d.split(",")).map((s) => s.trim()).filter(Boolean).sort();
    if (parts.length === 0) return { range: "N/A", count: 0 };
    const parseOne = (s) => {
      const [y, m, day] = s.split("-");
      return new Date(y, m - 1, day);
    };
    const first = parseOne(parts[0]);
    const last = parseOne(parts[parts.length - 1]);
    const startLabel = first.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const endLabel = last.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const range = parts.length > 1 ? `${startLabel} – ${endLabel}` : endLabel;
    return { range, count: parts.length };
  };

  const formatDateDisplayLocal = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  };

  const getTxKind = (log) => {
    const lower = (log.message || "").toLowerCase();
    if (lower.includes("deleted")) return "deleted";
    if (lower.includes("reversed") || lower.includes("reversal")) return "reversal";
    if (lower.includes("hr") && lower.includes("approv")) return "hr_approved";
    if ((lower.includes("supervisor") || lower.includes("immediate")) && lower.includes("approv")) return "supervisor_approved";
    if (lower.includes("approv")) return "approved";
    if (lower.includes("reject") || lower.includes("denied") || lower.includes("deny")) return "denied";
    if (lower.includes("cancel")) return "cancelled";
    if (lower.includes("credit") && (lower.includes("added") || lower.includes("monthly"))) return "credit_added";
    if (lower.includes("balance") && (lower.includes("remaining") || lower.includes("adjusted"))) return "balance_update";
    if (lower.includes("assigned") && (lower.includes("leave") || lower.includes("hrs"))) return "assigned";
    if (lower.includes("submit") || lower.includes("request") || lower.includes("filed")) return "submitted";
    if (lower.includes("pending")) return "pending";
    return "activity";
  };

  const kindMap = {
    submitted: { label: "Submitted", color: T.accent, bg: T.accentFaint, Icon: AddIcon },
    pending: { label: "Pending", color: "#F57C00", bg: "#FFF8E1", Icon: AccessTime },
    supervisor_approved: { label: "Supervisor Approved", color: "#1565C0", bg: "#E3F2FD", Icon: CheckCircle },
    hr_approved: { label: "HR Approved", color: "#2E7D32", bg: "#E8F5E9", Icon: CheckCircle },
    approved: { label: "Approved", color: "#2E7D32", bg: "#E8F5E9", Icon: CheckCircle },
    denied: { label: "Denied", color: "#C62828", bg: "#FFEBEE", Icon: Block },
    cancelled: { label: "Cancelled", color: "#757575", bg: "#F5F5F5", Icon: CancelIcon },
    deleted: { label: "Deleted", color: "#C62828", bg: "#FFEBEE", Icon: DeleteIcon },
    reversal: { label: "VL Reversal", color: "#B71C1C", bg: "#FFEBEE", Icon: Block },
    credit_added: { label: "Credit Added", color: "#2E7D32", bg: "#E8F5E9", Icon: AddIcon },
    balance_update: { label: "Balance Update", color: "#1565C0", bg: "#E3F2FD", Icon: WalletIcon },
    assigned: { label: "Leave Assigned", color: "#1565C0", bg: "#E3F2FD", Icon: AddIcon },
    activity: { label: "Activity", color: "#546E7A", bg: "#ECEFF1", Icon: ScheduleIcon },
  };

  const filteredTransactionLogs = useMemo(() => {
    const search = txSearchTerm.toLowerCase().trim();
    return transactionLogs.filter((log) => {
      const kind = getTxKind(log);
      if (txActionFilter !== "all" && kind !== txActionFilter) return false;
      if (!search) return true;
      const message = String(log.message || "").toLowerCase();
      const actionLabel = String(kindMap[kind]?.label || "").toLowerCase();
      return message.includes(search) || actionLabel.includes(search);
    });
  }, [transactionLogs, txSearchTerm, txActionFilter]); // eslint-disable-line

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(Math.max(filteredTransactionLogs.length, 0) / AUDIT_LOGS_PER_PAGE));
    if (auditLogPage > maxPage) setAuditLogPage(maxPage);
  }, [auditLogPage, filteredTransactionLogs.length]); // eslint-disable-line

  useEffect(() => { setAuditLogPage(1); }, [txSearchTerm, txActionFilter]);

  if (accessLoading || pageLoading) return <Wireframe />;
  if (!hasAccess) return <AccessDenied />;

  return (
    <Fade in timeout={400}>
      <Box
        sx={{
          py: { xs: 1, md: 2 },
          mt: { xs: 0, md: -2 },
          mb: { xs: 1, md: 2 },
          width: "100vw",
          maxWidth: "100%",
          position: "relative",
          left: "49%",
          transform: "translateX(-48%)",
          px: { xs: 2, sm: 3, md: 6 },
        }}
      >
        <Backdrop sx={{ color: "#fff", zIndex: (t) => t.zIndex.drawer + 1 }} open={loading}>
          <Box sx={{ textAlign: "center" }}>
            <CircularProgress color="inherit" size={48} thickness={4} />
            <Typography variant="body2" sx={{ mt: 1.5, color: "#fff" }}>Submitting…</Typography>
          </Box>
        </Backdrop>

        <SuccessfulOverlay open={successOpen} action={successAction} onClose={() => setSuccessOpen(false)} />

        <ErrorModal
          open={errorModal.open} onClose={closeError}
          title={errorModal.title} message={errorModal.message}
          icon={errorModal.icon} iconColor={errorModal.iconColor} iconBg={errorModal.iconBg}
        />
        <ConfirmModal
          open={confirmModal.open} onClose={closeConfirm} onConfirm={confirmModal.onConfirm}
          title={confirmModal.title} message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          confirmColor={confirmModal.confirmColor} confirmHoverColor={confirmModal.confirmHoverColor}
          icon={confirmModal.icon} iconColor={confirmModal.iconColor} iconBg={confirmModal.iconBg}
          loading={confirmModal.loading}
        />

        {/* ── Review Modal ── */}
        <ReviewModal
          open={reviewModal.open}
          onClose={closeReview}
          onConfirm={handleSubmitConfirmed}
          loading={loading}
          personID={personID}
          userName={userName}
          leaveCode={newLeaveRequest.leave_code}
          leaveDescription={leaveTypes.find((t) => t.leave_code === newLeaveRequest.leave_code)?.leave_description || ""}
          selectedDates={selectedDates}
          reason={reason}
          remainingDays={reviewModal.remainingDays}
          allocatedDays={reviewModal.allocatedDays}
        />

        {/* ── Leave Ledger Modal (read-only view of the balance breakdown) ── */}
        <Modal open={ledgerModalOpen} onClose={() => setLedgerModalOpen(false)} sx={{ display: "flex", alignItems: "center", justifyContent: "center", p: 2, zIndex: 1400 }}>
          <Fade in={ledgerModalOpen}>
            <Box sx={{ width: "100%", maxWidth: 620, borderRadius: 3, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.22)", bgcolor: T.surface }}>
              <Box sx={{ px: 3.5, py: 2.5, background: T.headerGrad, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                  <LedgerIcon sx={{ fontSize: 19, color: "#fff" }} />
                  <Typography sx={{ fontWeight: 700, color: "#fff", fontSize: "0.93rem" }}>Leave Ledger</Typography>
                </Box>
                <IconButton onClick={() => setLedgerModalOpen(false)} size="small" sx={{ color: "rgba(255,255,255,0.75)" }}>
                  <Close sx={{ fontSize: 16 }} />
                </IconButton>
              </Box>
              <Box sx={{ p: 2.5, display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: 2.5, columnGap: 2, maxHeight: "60vh", overflowY: "auto" }}>
                {groupedBalances.map((b) => {
                  const { icon: Icon, color, bg } = getBalanceStyle(b.code, b.description);
                  const remaining = parseFloat(b.totalDays);

                  return (
                    <Box key={b.code} sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
                      <Box sx={{ width: 40, height: 40, borderRadius: "50%", bgcolor: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Icon sx={{ fontSize: 19, color }} />
                      </Box>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: T.text, lineHeight: 1.25 }}>
                          {b.description}
                        </Typography>
                        <Typography sx={{ fontSize: "1.15rem", fontWeight: 800, color: T.text, lineHeight: 1.25 }}>
                          {remaining.toFixed(2)}
                        </Typography>
                        <Typography sx={{ fontSize: "0.68rem", color: T.faint }}>
                          days remaining
                        </Typography>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Fade>
        </Modal>

        {/* ── Page Header (same gradient-wash banner language as the HR admin panel) ── */}
        <SectionCard sx={{ mb: 2, overflow: "hidden" }}>
          <Box
            sx={{
              px: 3.5, py: 2.5,
              background: "linear-gradient(135deg, #fdf5f5 0%, #f0dede 100%)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              flexWrap: "wrap", gap: 1.5,
              position: "relative", overflow: "hidden",
            }}
          >
            <Box sx={{ position: "absolute", top: -50, right: -50, width: 200, height: 200, borderRadius: "50%", background: "radial-gradient(circle, rgba(109,35,35,0.09) 0%, transparent 70%)", pointerEvents: "none" }} />
            <Box sx={{ position: "absolute", bottom: -30, left: "35%", width: 140, height: 140, borderRadius: "50%", background: "radial-gradient(circle, rgba(109,35,35,0.06) 0%, transparent 70%)", pointerEvents: "none" }} />

            <Box sx={{ display: "flex", alignItems: "center", gap: 2, position: "relative", zIndex: 1 }}>
              <EventNote sx={{ fontSize: 30, color: T.accent }} />
              <Box>
                <Typography sx={{ fontSize: "1.15rem", fontWeight: 800, color: T.accent, lineHeight: 1.25 }}>
                  Employee Leave Request
                </Typography>
                <Typography sx={{ fontSize: "0.78rem", color: T.accentMid, fontWeight: 600, opacity: 0.9 }}>
                  Submit and track your leave requests
                </Typography>
              </Box>
            </Box>

            <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, position: "relative", zIndex: 1 }}>
              <AccentButton
                onClick={() => { setTransactionLogsModalOpen(true); setAuditLogPage(1); }}
                variant="contained"
                startIcon={<HistoryToggleOff sx={{ fontSize: "15px !important" }} />}
                sx={{ fontSize: "0.8rem", bgcolor: T.accent, color: "#fff", boxShadow: `0 2px 10px ${alpha(T.accent, 0.32)}`, "&:hover": { bgcolor: T.accentDark } }}
              >
                Transaction Logs
              </AccentButton>
              <Tooltip title="Refresh">
                <IconButton
                  onClick={() => window.location.reload()}
                  size="small"
                  sx={{ color: T.accent, bgcolor: "#fff", border: `1px solid ${alpha(T.accent, 0.2)}`, borderRadius: 1.5, "&:hover": { bgcolor: T.accentFaint, borderColor: T.accent } }}
                >
                  <Refresh sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        </SectionCard>

        {/* ── Leave Balances ── */}
        <SectionCard sx={{ mb: 2 }}>
          <Box sx={{ px: 3.5, py: 1.4, borderBottom: `1px solid ${T.divider}`, bgcolor: T.accentFaint, display: "flex", alignItems: "center", gap: 1.5 }}>
            <WalletIcon sx={{ fontSize: 15, color: T.accent }} />
            <Typography sx={{ fontSize: "0.82rem", fontWeight: 700, color: T.accent }}>Leave Balances</Typography>
            <Typography sx={{ fontSize: "0.75rem", color: T.accentMid, opacity: 0.85 }}>Remaining credits per type</Typography>
            <Box sx={{ flex: 1 }} />
            {/* <AccentButton
              onClick={() => setLedgerModalOpen(true)}
              variant="outlined"
              startIcon={<LedgerIcon sx={{ fontSize: "16px !important" }} />}
              sx={{ fontSize: "0.8rem", color: "#fff", borderColor: T.accentBorder, bgcolor: T.accent, "&:hover": { bgcolor: T.accent, borderColor: T.accent } }}            >
              View Leave Ledger
            </AccentButton> */}
          </Box>
          <Box sx={{ px: 3, py: 2.5 }}>
            {groupedBalances.length === 0 ? (
              <Typography sx={{ py: 1.5, color: T.faint, fontSize: "0.82rem", textAlign: "center" }}>
                No balance information available.
              </Typography>
            ) : (
              <Box sx={{ position: "relative" }}>
                <Box
                  ref={balancesScrollRef}
                  onScroll={updateBalancesScroll}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "nowrap",
                    overflowX: "auto",
                    scrollbarWidth: "auto",
                    pb: 1,
                    "&::-webkit-scrollbar": { height: 9 },
                    "&::-webkit-scrollbar-thumb": { bgcolor: alpha(T.accent, 0.35), borderRadius: 5, "&:hover": { bgcolor: alpha(T.accent, 0.55) } },
                    "&::-webkit-scrollbar-track": { bgcolor: alpha(T.accent, 0.06), borderRadius: 5 },
                  }}
                >
                  {groupedBalances.map((balance, idx) => {
                    const { icon: Icon, color, bg } = getBalanceStyle(balance.code, balance.description);
                    const remaining = parseFloat(balance.totalDays);

                    return (
                      <React.Fragment key={balance.code}>
                        {idx !== 0 && (
                          <Divider orientation="vertical" flexItem sx={{ mx: { xs: 1.5, md: 3 }, borderColor: T.divider, my: 0.5 }} />
                        )}
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexShrink: 0 }}>
                          <Box sx={{ width: 44, height: 44, borderRadius: "50%", bgcolor: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <Icon sx={{ fontSize: 21, color }} />
                          </Box>
                          <Box sx={{ minWidth: 0 }}>
                            <Typography sx={{ fontSize: "0.82rem", fontWeight: 600, color: T.text, whiteSpace: "nowrap" }}>
                              {balance.description}
                            </Typography>
                            <Typography sx={{ fontSize: "1.4rem", fontWeight: 800, color: T.text, lineHeight: 1.2 }}>
                              {remaining.toFixed(2)}
                            </Typography>
                            <Typography sx={{ fontSize: "0.72rem", color: T.faint, whiteSpace: "nowrap" }}>
                              days remaining
                            </Typography>
                          </Box>
                        </Box>
                      </React.Fragment>
                    );
                  })}
                </Box>

                {/* Fade edges + arrow buttons — only rendered when there's actually more to scroll to,
                    so non-technical users get an unmistakable visual cue instead of a faint scrollbar. */}
                {balancesScroll.canLeft && (
                  <>
                    <Box sx={{ position: "absolute", left: 0, top: 0, bottom: 8, width: 48, pointerEvents: "none", background: "linear-gradient(90deg, #fff 10%, rgba(255,255,255,0) 100%)", zIndex: 1 }} />
                    <IconButton
                      onClick={() => scrollBalances(-1)}
                      size="small"
                      sx={{
                        position: "absolute", left: -6, top: "40%", transform: "translateY(-50%)", zIndex: 2,
                        width: 30, height: 30, bgcolor: "#fff", color: T.accent,
                        border: `1px solid ${T.accentBorder}`, boxShadow: "0 2px 8px rgba(0,0,0,0.14)",
                        "&:hover": { bgcolor: T.accentFaint },
                      }}
                    >
                      <NavigateBefore sx={{ fontSize: 18 }} />
                    </IconButton>
                  </>
                )}
                {balancesScroll.canRight && (
                  <>
                    <Box sx={{ position: "absolute", right: 0, top: 0, bottom: 8, width: 48, pointerEvents: "none", background: "linear-gradient(270deg, #fff 10%, rgba(255,255,255,0) 100%)", zIndex: 1 }} />
                    <IconButton
                      onClick={() => scrollBalances(1)}
                      size="small"
                      sx={{
                        position: "absolute", right: -6, top: "40%", transform: "translateY(-50%)", zIndex: 2,
                        width: 30, height: 30, bgcolor: "#fff", color: T.accent,
                        border: `1px solid ${T.accentBorder}`, boxShadow: "0 2px 8px rgba(0,0,0,0.14)",
                        "&:hover": { bgcolor: T.accentFaint },
                      }}
                    >
                      <NavigateNext sx={{ fontSize: 18 }} />
                    </IconButton>
                  </>
                )}
              </Box>
            )}
          </Box>
        </SectionCard>

        {/* ── Two Column ── */}
        <Grid ref={columnsRef} container spacing={2} alignItems="stretch">

          {/* ── LEFT: Submit Form ── */}
          <Grid item xs={12} lg={5} sx={{ display: "flex" }}>
            <SectionCard sx={{ width: "100%", display: "flex", flexDirection: "column", height: panelHeight ? `${panelHeight}px` : "auto" }}>
              <Box sx={{ px: 3.5, py: 1.4, borderBottom: `1px solid ${T.divider}`, bgcolor: T.accentFaint, display: "flex", alignItems: "center", gap: 1.5, flexShrink: 0 }}>
                <SendIcon sx={{ fontSize: 15, color: T.accent, transform: "rotate(-25deg)" }} />
                <Typography sx={{ fontSize: "0.82rem", fontWeight: 700, color: T.accent }}>Submit New Leave Request</Typography>
                <Box sx={{ flex: 1 }} />
                <Typography sx={{ fontSize: "0.72rem", color: T.accentMid, opacity: 0.85 }}>
                  <Box component="span" sx={{ color: "#c62828" }}>*</Box> required
                </Typography>
              </Box>

              <Box
                sx={{
                  px: 3.5, py: 3, flexGrow: 1, overflowY: "auto",
                  display: "flex", flexDirection: "column", gap: 0,
                  "&::-webkit-scrollbar": { width: 4 },
                  "&::-webkit-scrollbar-thumb": { bgcolor: T.accentBorder, borderRadius: 2 },
                }}
              >
                <Box sx={{ mb: 2 }}>
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: T.text, mb: 0.75 }}>
                    Leave Type <Box component="span" sx={{ color: "#c62828" }}>*</Box>
                  </Typography>
                  <FormControl fullWidth size="small">
                    <Select
                      value={newLeaveRequest.leave_code}
                      onChange={(e) => { setNewLeaveRequest((p) => ({ ...p, leave_code: e.target.value })); setSelectedDates([]); }}
                      displayEmpty
                      sx={selectSx}
                      renderValue={(v) =>
                        v ? (
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            <Box sx={{ px: 1, py: 0.2, borderRadius: 1, bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}` }}>
                              <Typography sx={{ fontSize: "0.7rem", fontWeight: 800, color: T.accent }}>{v}</Typography>
                            </Box>
                            <Typography sx={{ fontSize: "0.875rem" }}>
                              {leaveTypes.find((t) => t.leave_code === v)?.leave_description || ""}
                            </Typography>
                          </Box>
                        ) : (
                          <Typography sx={{ fontSize: "0.875rem", color: T.faint }}>Select leave type</Typography>
                        )
                      }
                    >
                      <MenuItem value=""><em>Select Leave Type</em></MenuItem>
                      {leaveTypes.map((type) => (
                        <MenuItem key={type.id} value={type.leave_code}>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            <Box sx={{ px: 1, py: 0.2, borderRadius: 1, bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}` }}>
                              <Typography sx={{ fontSize: "0.7rem", fontWeight: 800, color: T.accent }}>{type.leave_code}</Typography>
                            </Box>
                            <Typography sx={{ fontSize: "0.875rem" }}>{type.leave_description}</Typography>
                          </Box>
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>

                <Box sx={{ mb: 1 }}>
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: T.text, mb: 0.75 }}>
                    Leave Date(s) <Box component="span" sx={{ color: "#c62828" }}>*</Box>
                  </Typography>
                  <AccentButton
                    variant="outlined"
                    onClick={() => setDateModalOpen(true)}
                    fullWidth
                    startIcon={<CalendarIcon sx={{ fontSize: "16px !important", color: T.faint }} />}
                    sx={{
                      height: 42, border: `1px solid ${T.divider}`,
                      color: selectedDates.length ? T.text : T.faint,
                      justifyContent: "flex-start", px: 1.5, fontWeight: 500,
                      bgcolor: "#fff",
                      "&:hover": { bgcolor: T.accentFaint, borderColor: T.accent, color: T.accent, transform: "none" },
                    }}
                  >
                    <Typography sx={{ fontSize: "0.875rem" }}>
                      {selectedDates.length > 0 ? `${selectedDates.length} date(s) selected` : "Select start and end date"}
                    </Typography>
                  </AccentButton>
                  <Typography sx={{ fontSize: "0.72rem", color: T.faint, mt: 0.6 }}>
                    Select both start and end dates of your leave.
                  </Typography>
                  {isSickLeave() && (
                    <Typography sx={{ fontSize: "0.68rem", color: "#1565C0", mt: 0.5, fontStyle: "italic" }}>
                      * Past dates allowed for sick leave
                    </Typography>
                  )}
                  <LeaveDatePicker
                    open={dateModalOpen}
                    onClose={() => { setNewLeaveRequest((p) => ({ ...p, leave_date: selectedDates.join(",") })); setDateModalOpen(false); }}
                    selectedDates={selectedDates}
                    setSelectedDates={setSelectedDates}
                    accentColor={T.accent}
                    accentDark={T.accentDark}
                    primaryColor="#fdf5f5"
                    secondaryColor="#f0dede"
                    allowPastDates={isSickLeave()}
                    leaveType={newLeaveRequest.leave_code}
                    leaveRequests={leaveRequests}
                    maxSelectableDates={null}
                  />
                </Box>

                <Box sx={{ mb: 2, mt: 1.75 }}>
                  <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: T.text, mb: 0.75 }}>Selected Dates</Typography>
                  <Box
                    sx={{
                      minHeight: 44, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 0.75,
                      p: 1.5, border: `1px solid ${T.divider}`, borderRadius: 2, bgcolor: "#fafafa",
                    }}
                  >
                    {selectedDates.length > 0 ? (
                      selectedDates.map((date) => {
                        const isHRApproved = leaveRequests.some(
                          (req) =>
                            (req.leave_date || "").split(",").map((s) => s.trim()).includes(date) &&
                            String(req.status) === "2",
                        );
                        const chip = (
                          <Chip
                            key={date}
                            size="small"
                            label={formatDateDisplayLocal(date)}
                            onDelete={isHRApproved ? undefined : () => setSelectedDates((prev) => prev.filter((d) => d !== date))}
                            sx={{
                              bgcolor: isHRApproved ? alpha("#C62828", 0.1) : alpha("#2E7D32", 0.1),
                              color: isHRApproved ? "#C62828" : "#2E7D32",
                              fontWeight: 600, fontSize: "0.75rem", height: 24,
                              border: `1px solid ${alpha(isHRApproved ? "#C62828" : "#2E7D32", 0.25)}`,
                            }}
                            disabled={isHRApproved}
                          />
                        );
                        return isHRApproved ? (
                          <Tooltip key={date} title="HR-approved leave already exists on this date." arrow>
                            <span>{chip}</span>
                          </Tooltip>
                        ) : chip;
                      })
                    ) : (
                      <Typography sx={{ fontSize: "0.78rem", color: T.faint }}>No dates selected</Typography>
                    )}
                  </Box>
                </Box>

                <Box sx={{ mb: 1 }}>
                  <Typography sx={{ fontSize: "0.78rem", fontWeight: 600, color: T.text, mb: 0.75 }}>
                    Reason / Purpose <Box component="span" sx={{ color: T.faint, fontWeight: 400 }}>(Optional)</Box>
                  </Typography>
                  <FieldInput
                    value={reason}
                    onChange={(e) => setReason(e.target.value.slice(0, 255))}
                    placeholder="Write reason for leave…"
                    fullWidth
                    multiline
                    minRows={3}
                    inputProps={{ maxLength: 255 }}
                  />
                  <Typography sx={{ fontSize: "0.68rem", color: T.faint, mt: 0.5, textAlign: "right" }}>
                    {reason.length} / 255
                  </Typography>
                </Box>

                <Box sx={{ flexGrow: 1 }} />

                <AccentButton
                  onClick={handleAdd}
                  variant="contained"
                  fullWidth
                  startIcon={<SendIcon sx={{ fontSize: "15px !important" }} />}
                  disabled={loading}
                  sx={{
                    height: 44, bgcolor: T.accent, color: "#fff", fontWeight: 600, mt: 1,
                    "&:hover": { bgcolor: T.accentDark },
                    "&:disabled": { bgcolor: "#e0e0e0 !important", color: "#9e9e9e !important" },
                  }}
                >
                  Submit Leave Request
                </AccentButton>
              </Box>
            </SectionCard>
          </Grid>

          {/* ── RIGHT: Records ── */}
          <Grid item xs={12} lg={7} sx={{ display: "flex" }}>
            <SectionCard sx={{ width: "100%", display: "flex", flexDirection: "column", height: panelHeight ? `${panelHeight}px` : "auto" }}>
              <Box sx={{ px: 3.5, py: 2, borderBottom: `1px solid ${T.divider}`, bgcolor: T.accentFaint, flexShrink: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2, flexWrap: "wrap", gap: 1.5 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
                    <TableRowsIcon sx={{ fontSize: 17, color: T.accent }} />
                    <Typography sx={{ fontSize: "0.82rem", fontWeight: 700, color: T.accent }}>My Leave Request Records</Typography>
                  </Box>
                  <FieldInput
                    value={reqSearchTerm}
                    onChange={(e) => setReqSearchTerm(e.target.value)}
                    placeholder="Search requests…"
                    size="small"
                    sx={{ minWidth: 200, "& .MuiOutlinedInput-root": { pl: 0.5 } }}
                    InputProps={{ startAdornment: <SearchIcon sx={{ fontSize: 16, color: T.faint, mr: 1 }} /> }}
                  />
                </Box>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                  <Typography sx={{ fontSize: "0.75rem", fontWeight: 600, color: T.muted }}>Filter by:</Typography>
                  <FormControl size="small" sx={{ minWidth: 110 }}>
                    <Select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} displayEmpty sx={{ ...selectSx, fontSize: "0.78rem" }} renderValue={(v) => v ? months.find((m) => m.value === v)?.label : "Month"}>
                      {months.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 120 }}>
                    <Select value={leaveTypeFilter} onChange={(e) => setLeaveTypeFilter(e.target.value)} displayEmpty sx={{ ...selectSx, fontSize: "0.78rem" }} renderValue={(v) => v || "Leave Type"}>
                      <MenuItem value=""><em>All Types</em></MenuItem>
                      {leaveTypes.map((t) => <MenuItem key={t.id} value={t.leave_code}>{t.leave_code}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 110 }}>
                    <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} displayEmpty sx={{ ...selectSx, fontSize: "0.78rem" }} renderValue={(v) => v ? statusOptions.find((s) => s.value === v)?.label : "Status"}>
                      {statusOptions.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Box sx={{ flex: 1 }} />
                  <AccentButton
                    onClick={clearRequestFilters}
                    variant="outlined"
                    startIcon={<FilterAltIcon sx={{ fontSize: "14px !important" }} />}
                    sx={{ fontSize: "0.76rem", color: T.accent, borderColor: T.accentBorder, "&:hover": { bgcolor: T.accentFaint, borderColor: T.accent } }}
                  >
                    Clear Filters
                  </AccentButton>
                </Box>
              </Box>

              <Box sx={{ px: 3.5, py: 1.1, display: "grid", gridTemplateColumns: "120px 150px 1fr 130px 80px", gap: 1, alignItems: "center", bgcolor: "#f7f7f7", borderBottom: `1px solid ${T.divider}`, flexShrink: 0 }}>
                {["Leave Type", "Date", "Submitted", "Status", "Action"].map((col) => (
                  <Typography key={col} sx={{ fontSize: "0.65rem", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                    {col}
                  </Typography>
                ))}
              </Box>

              <Box sx={{ flexGrow: 1, overflowY: "auto", "&::-webkit-scrollbar": { width: 4 }, "&::-webkit-scrollbar-thumb": { bgcolor: T.accentBorder, borderRadius: 2 } }}>
                {filteredLeaveRequests.length === 0 ? (
                  <Box sx={{ py: 10, textAlign: "center" }}>
                    <Box sx={{ width: 64, height: 64, borderRadius: "50%", bgcolor: T.accentFaint, display: "flex", alignItems: "center", justifyContent: "center", mx: "auto", mb: 2 }}>
                      <EventNote sx={{ fontSize: 28, color: alpha(T.accent, 0.3) }} />
                    </Box>
                    <Typography sx={{ fontSize: "0.88rem", fontWeight: 600, color: T.muted, mb: 0.5 }}>No leave requests found</Typography>
                    <Typography sx={{ fontSize: "0.78rem", color: T.faint }}>
                      {monthFilter || leaveTypeFilter || statusFilter || reqSearchTerm ? "Try adjusting your filters" : "Submit your first request using the form"}
                    </Typography>
                  </Box>
                ) : (
                  paginatedLeaveRequests.map((req, idx) => {
                    const canCancel = String(req.status) === "0";
                    const typeDesc = leaveTypes.find((t) => t.leave_code === req.leave_code)?.leave_description || req.leave_code;
                    const { range, count } = formatDateRange(req.leave_date);
                    return (
                      <Box
                        key={req.id}
                        sx={{
                          px: 3.5, py: 1.6,
                          display: "grid", gridTemplateColumns: "120px 150px 1fr 130px 80px",
                          gap: 1, alignItems: "center",
                          bgcolor: idx % 2 === 0 ? T.rowEven : T.rowOdd,
                          borderBottom: `1px solid ${T.divider}`,
                          "&:last-child": { borderBottom: "none" },
                          "&:hover": { bgcolor: T.rowHover },
                        }}
                      >
                        <Box>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 0.25 }}>
                            <Box sx={{ px: 0.75, py: 0.15, borderRadius: 1, bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}` }}>
                              <Typography sx={{ fontSize: "0.65rem", fontWeight: 800, color: T.accent }}>{req.leave_code}</Typography>
                            </Box>
                          </Box>
                          <Typography sx={{ fontSize: "0.72rem", color: T.muted }} noWrap>{typeDesc}</Typography>
                        </Box>
                        <Box>
                          <Typography sx={{ fontSize: "0.8rem", color: T.text, fontWeight: 600 }}>{range}</Typography>
                          <Typography sx={{ fontSize: "0.7rem", color: T.faint }}>({count} day{count !== 1 ? "s" : ""})</Typography>
                        </Box>
                        <Box>
                          <Typography sx={{ fontSize: "0.78rem", color: T.text }}>
                            {req.created_at ? new Date(req.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "N/A"}
                          </Typography>
                          <Typography sx={{ fontSize: "0.7rem", color: T.faint }}>
                            {req.created_at ? new Date(req.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : ""}
                          </Typography>
                        </Box>
                        <StatusPill status={req.status} />
                        <Box>
                          {canCancel ? (
                            <AccentButton
                              size="small" variant="outlined"
                              onClick={() => handleCancelRequest(req.id)}
                              sx={{
                                fontSize: "0.7rem", px: 1, py: 0.35, height: 26, minWidth: 0,
                                borderColor: alpha("#C62828", 0.3), color: "#C62828",
                                "&:hover": { bgcolor: alpha("#C62828", 0.06), borderColor: "#C62828", transform: "none" },
                              }}
                            >
                              Cancel
                            </AccentButton>
                          ) : (
                            <Typography sx={{ fontSize: "0.8rem", color: T.faint }}>—</Typography>
                          )}
                        </Box>
                      </Box>
                    );
                  })
                )}
              </Box>

              {filteredLeaveRequests.length > 0 && (
                <Box sx={{ px: 3.5, py: 1.5, borderTop: `1px solid ${T.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 1, flexShrink: 0 }}>
                  <Typography sx={{ fontSize: "0.76rem", color: T.faint }}>
                    Showing {(reqPage - 1) * REQ_LOGS_PER_PAGE + 1} to {Math.min(reqPage * REQ_LOGS_PER_PAGE, filteredLeaveRequests.length)} of {filteredLeaveRequests.length} entries
                  </Typography>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                    <IconButton
                      size="small"
                      disabled={reqPage === 1}
                      onClick={() => setReqPage((p) => p - 1)}
                      sx={{ width: 30, height: 30, borderRadius: 1.5, border: `1px solid ${T.divider}`, color: reqPage === 1 ? T.faint : T.text }}
                    >
                      <NavigateBefore sx={{ fontSize: 16 }} />
                    </IconButton>
                    {Array.from({ length: reqTotalPages }, (_, i) => i + 1).map((p) => (
                      <Box
                        key={p}
                        onClick={() => setReqPage(p)}
                        sx={{
                          width: 30, height: 30, borderRadius: 1.5, display: "flex", alignItems: "center", justifyContent: "center",
                          cursor: "pointer", fontSize: "0.78rem", fontWeight: 700,
                          bgcolor: reqPage === p ? T.accent : "#fff",
                          color: reqPage === p ? "#fff" : T.text,
                          border: `1px solid ${reqPage === p ? T.accent : T.divider}`,
                        }}
                      >
                        {p}
                      </Box>
                    ))}
                    <IconButton
                      size="small"
                      disabled={reqPage === reqTotalPages}
                      onClick={() => setReqPage((p) => p + 1)}
                      sx={{ width: 30, height: 30, borderRadius: 1.5, border: `1px solid ${T.divider}`, color: reqPage === reqTotalPages ? T.faint : T.text }}
                    >
                      <NavigateNext sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Box>
                </Box>
              )}
            </SectionCard>
          </Grid>
        </Grid>

        {/* ── Transaction Logs Modal ── */}
        <Modal
          open={transactionLogsModalOpen}
          onClose={() => setTransactionLogsModalOpen(false)}
          sx={{ display: "flex", alignItems: "center", justifyContent: "center", p: 2 }}
        >
          <Fade in={transactionLogsModalOpen}>
            <Box sx={{ width: "100%", maxWidth: 620, maxHeight: "90vh", borderRadius: 3, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.22)", bgcolor: T.surface, display: "flex", flexDirection: "column" }}>
              <Box sx={{ px: 3.5, py: 2.5, background: T.headerGrad, display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", overflow: "hidden", flexShrink: 0 }}>
                <Box sx={{ position: "absolute", top: -50, right: -30, width: 180, height: 180, borderRadius: "50%", bgcolor: "rgba(255,255,255,0.04)" }} />
                <Box sx={{ display: "flex", alignItems: "center", gap: 2, position: "relative", zIndex: 1 }}>
                  <Box sx={{ width: 38, height: 38, borderRadius: 2, bgcolor: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <HistoryToggleOff sx={{ fontSize: 18, color: "#fff" }} />
                  </Box>
                  <Box>
                    <Typography sx={{ fontWeight: 700, color: "#fff", fontSize: "0.95rem", lineHeight: 1.2, mb: 0.3 }}>Transaction Logs</Typography>
                    <Typography sx={{ fontSize: "0.72rem", color: "rgba(255,255,255,0.68)" }}>
                      {filteredTransactionLogs.length > 0 ? `${filteredTransactionLogs.length} of ${transactionLogs.length} recorded action(s)` : "All activity on your leave requests"}
                    </Typography>
                  </Box>
                </Box>
                <IconButton onClick={() => setTransactionLogsModalOpen(false)} size="small" sx={{ color: "rgba(255,255,255,0.75)", position: "relative", zIndex: 1, "&:hover": { bgcolor: "rgba(255,255,255,0.12)" } }}>
                  <Close sx={{ fontSize: 17 }} />
                </IconButton>
              </Box>

              <Box sx={{ px: 3, py: 2, bgcolor: T.accentFaint, borderBottom: `1px solid ${T.divider}`, display: "flex", flexDirection: "column", gap: 1.25 }}>
                <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                  <Box sx={{ position: "relative", flex: 1, minWidth: 200 }}>
                    <ManageSearchIcon sx={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: T.faint, pointerEvents: "none" }} />
                    <FieldInput
                      value={txSearchTerm}
                      onChange={(e) => setTxSearchTerm(e.target.value)}
                      placeholder="Search activity…"
                      size="small"
                      fullWidth
                      sx={{ "& .MuiOutlinedInput-root": { pl: 1.5 } }}
                    />
                  </Box>
                  <AccentButton
                    onClick={() => setTxSearchTerm("")}
                    variant="outlined"
                    startIcon={<FilterAltIcon sx={{ fontSize: "14px !important" }} />}
                    sx={{ fontSize: "0.74rem", color: T.accent, borderColor: T.accentBorder, bgcolor: "#fff", "&:hover": { bgcolor: T.accentFaint, borderColor: T.accent, transform: "none" } }}
                  >
                    Clear
                  </AccentButton>
                </Box>
                <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
                  {[
                    { label: "All actions", value: "all" },
                    { label: "Submitted", value: "submitted" },
                    { label: "Supervisor", value: "supervisor_approved" },
                    { label: "HR approved", value: "hr_approved" },
                    { label: "Denied", value: "denied" },
                    { label: "Cancelled", value: "cancelled" },
                  ].map((opt) => (
                    <Box
                      key={opt.value}
                      onClick={() => setTxActionFilter(opt.value)}
                      sx={{
                        px: 1.35, py: 0.45, borderRadius: 999, cursor: "pointer", fontSize: "0.72rem", fontWeight: 700,
                        border: `1px solid ${txActionFilter === opt.value ? T.accent : T.accentBorder}`,
                        color: txActionFilter === opt.value ? "#fff" : T.accent,
                        bgcolor: txActionFilter === opt.value ? T.accent : "#fff",
                        transition: "all 0.15s ease",
                        "&:hover": { bgcolor: txActionFilter === opt.value ? T.accentDark : T.accentFaint },
                      }}
                    >
                      {opt.label}
                    </Box>
                  ))}
                </Box>
              </Box>

              <Box sx={{ px: 3, py: 2.5, overflowY: "auto", flexGrow: 1, bgcolor: T.accentFaint, "&::-webkit-scrollbar": { width: 4 }, "&::-webkit-scrollbar-thumb": { bgcolor: T.accentBorder, borderRadius: 2 } }}>
                {transactionLogsLoading ? (
                  <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
                    {[...Array(AUDIT_LOGS_PER_PAGE)].map((_, i) => (
                      <Box key={i} sx={{ p: 2.5, borderRadius: 2, bgcolor: "#fff", border: `1px solid ${T.accentBorder}` }}>
                        <Bone w={90} h={16} sx={{ mb: 1 }} />
                        <Bone w="80%" h={12} sx={{ mb: 0.75 }} />
                        <Bone w="55%" h={12} />
                      </Box>
                    ))}
                  </Box>
                ) : transactionLogsError ? (
                  <Alert severity="error" sx={{ borderRadius: 2 }}>{transactionLogsError}</Alert>
                ) : filteredTransactionLogs.length === 0 ? (
                  <Box sx={{ py: 10, textAlign: "center" }}>
                    <Box sx={{ width: 72, height: 72, borderRadius: "50%", bgcolor: "rgba(255,255,255,0.8)", display: "flex", alignItems: "center", justifyContent: "center", mx: "auto", mb: 2 }}>
                      <HistoryToggleOff sx={{ fontSize: 32, color: alpha(T.accent, 0.3) }} />
                    </Box>
                    <Typography sx={{ fontSize: "0.9rem", fontWeight: 600, color: T.muted }}>
                      {transactionLogs.length === 0 ? "No activity yet." : "No logs match your filters."}
                    </Typography>
                    <Typography sx={{ fontSize: "0.78rem", color: T.faint }}>
                      {transactionLogs.length === 0 ? "Actions on your leave requests will appear here." : "Try a different search or action filter."}
                    </Typography>
                  </Box>
                ) : (
                  (() => {
                    const totalPages = Math.max(1, Math.ceil(filteredTransactionLogs.length / AUDIT_LOGS_PER_PAGE));
                    const paginated = filteredTransactionLogs.slice(
                      (auditLogPage - 1) * AUDIT_LOGS_PER_PAGE,
                      auditLogPage * AUDIT_LOGS_PER_PAGE,
                    );
                    return (
                      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
                        {paginated.map((log) => {
                          const kind = getTxKind(log);
                          const { label, color, bg, Icon } = kindMap[kind] || kindMap.activity;
                          const loggedAt = log.created_at || log.createdAt || log.timestamp;
                          const timeLabel = loggedAt
                            ? (() => {
                                const d = new Date(loggedAt);
                                return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} • ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
                              })()
                            : null;
                          const raw = (log.message || "").trim();
                          // Redact actor name inside the message for employee-facing view.
                          // Example: "Juan Dela Cruz (20134507) assigned ..." → "20134507 assigned ..."
                          const redactedRaw = raw.replace(/^[^(]*\((\d+)\)\s+/g, "$1 ");
                          const sentence =
                            (redactedRaw.charAt(0).toUpperCase() + redactedRaw.slice(1)) +
                            (redactedRaw.endsWith(".") ? "" : ".");
                          // Transaction logs should show ONLY the actor employee number (no name).
                          const logEmpNum = log.employee_id || log.employeeNumber || personID;

                          return (
                            <Box
                              key={`log-${log.id}`}
                              sx={{
                                bgcolor: "#fff", borderRadius: 2, p: 2.5,
                                border: `1px solid ${T.accentBorder}`,
                                borderLeft: `4px solid ${color}`,
                                boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                                "&:hover": { boxShadow: `0 4px 12px ${alpha(color, 0.12)}` },
                              }}
                            >
                              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.25, flexWrap: "wrap", gap: 1 }}>
                                <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.6, px: 1.25, py: 0.35, borderRadius: "6px", bgcolor: bg, border: `1px solid ${alpha(color, 0.2)}` }}>
                                  <Icon sx={{ fontSize: 12, color }} />
                                  <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, color, lineHeight: 1 }}>{label}</Typography>
                                </Box>
                                {timeLabel && (
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    <ScheduleIcon sx={{ fontSize: 11, color: T.faint }} />
                                    <Typography sx={{ fontSize: "0.7rem", color: T.faint }}>{timeLabel}</Typography>
                                  </Box>
                                )}
                              </Box>
                              {logEmpNum && (
                                <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 1 }}>
                                  <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, px: 1.25, py: 0.5, bgcolor: alpha("#1565C0", 0.05), borderRadius: 1.5, border: "1px solid rgba(21,101,192,0.15)" }}>
                                    <PersonIcon sx={{ fontSize: 13, color: "#1565C0" }} />
                                    <Typography sx={{ fontSize: "0.75rem", fontWeight: 700, color: "#1565C0", lineHeight: 1 }}>#{logEmpNum}</Typography>
                                  </Box>
                                </Box>
                              )}
                              <Typography sx={{ fontSize: "0.86rem", fontWeight: 400, color: T.text, lineHeight: 1.6 }}>{sentence}</Typography>
                            </Box>
                          );
                        })}

                        {totalPages > 1 && (
                          <Box sx={{ mt: 1, pt: 2, borderTop: `1px solid ${T.divider}`, display: "flex", alignItems: "center", justifyContent: "center", gap: 1, flexWrap: "wrap" }}>
                            <IconButton
                              size="small"
                              disabled={auditLogPage === 1}
                              onClick={() => setAuditLogPage((p) => p - 1)}
                              sx={{ width: 32, height: 32, borderRadius: 1.5, border: `1px solid ${auditLogPage === 1 ? T.divider : T.accentBorder}`, color: auditLogPage === 1 ? T.faint : T.accent }}
                            >
                              <NavigateBefore sx={{ fontSize: 16 }} />
                            </IconButton>
                            <Box sx={{ fontSize: "0.78rem", fontWeight: 700, color: T.accent, px: 1.25, py: 0.45, borderRadius: 1.5, bgcolor: "#fff", border: `1px solid ${T.accentBorder}` }}>
                              Page {auditLogPage} of {totalPages}
                            </Box>
                            <IconButton
                              size="small"
                              disabled={auditLogPage === totalPages}
                              onClick={() => setAuditLogPage((p) => p + 1)}
                              sx={{ width: 32, height: 32, borderRadius: 1.5, border: `1px solid ${auditLogPage === totalPages ? T.divider : T.accentBorder}`, color: auditLogPage === totalPages ? T.faint : T.accent }}
                            >
                              <NavigateNext sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Box>
                        )}
                      </Box>
                    );
                  })()
                )}
              </Box>
            </Box>
          </Fade>
        </Modal>

        {/* Scroll to Top */}
        <Fade in={showScrollTop}>
          <Box
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            sx={{
              position: "fixed", bottom: 24, right: 24, zIndex: 1000,
              width: 40, height: 40, borderRadius: "50%",
              bgcolor: T.accent, color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
              transition: "all 0.3s ease",
              "&:hover": { bgcolor: T.accentDark, transform: "translateY(-2px)" },
            }}
          >
            <KeyboardArrowUp sx={{ fontSize: 20 }} />
          </Box>
        </Fade>
      </Box>
    </Fade>
  );
};

export default LeaveRequestUser;