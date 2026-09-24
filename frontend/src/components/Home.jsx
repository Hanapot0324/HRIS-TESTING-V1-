import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { useNavigate, useLocation } from "react-router-dom";
import axios from "axios";
import { useSocket } from "../contexts/SocketContext";
import API_BASE_URL from "../apiConfig";
import { getAuthHeaders } from "../utils/auth";
import {
  employeeNumbersMatch,
  extractNotificationList,
  findById,
  inferNotificationType,
  latestByDate,
  normalizeNotification,
  parseNotificationTargetId,
  resolveEmployeeNumber,
  scopeNotificationsToEmployee,
  sortNotificationsLatestFirst,
} from "../utils/notifications";
import {
  IconButton, Modal, Tooltip, Box, Grid, Typography, Avatar, Button,
  Badge, Card, CardContent, Divider, Chip, TextField, Dialog, DialogTitle,
  DialogContent, DialogActions, Grow, Fade, Menu, MenuItem, CircularProgress,
  FormControl, InputLabel, Select, LinearProgress, Skeleton, alpha, styled,
} from "@mui/material";
import ArrowBackIosNewIcon from "@mui/icons-material/ArrowBackIosNew";
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos";
import NotificationsIcon from "@mui/icons-material/Notifications";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import CloseIcon from "@mui/icons-material/Close";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import {
  Receipt, ContactPage, Event, CalendarMonth, Logout, Settings,
  Close, Add, Note, Flag,
  PlayArrow, Pause, AccountCircle, HelpOutline, PrivacyTip, MoreVert, Delete, Save, ArrowDropDown,
  PeopleAlt as PeopleAltIcon, Work as WorkIcon, MedicalServices as MedicalServicesIcon,
  WarningAmber as WarningAmberIcon, Favorite as FavoriteIcon, EscalatorWarning as EscalatorWarningIcon,
  School as SchoolIcon, BeachAccess as BeachAccessIcon, Spa as SpaIcon,
  PregnantWoman as PregnantWomanIcon, EventNote as EventNoteIcon,
  PieChartOutline as PieChartOutlineIcon, InfoOutlined as InfoOutlinedIcon,
  WbSunny as WbSunnyIcon,
} from "@mui/icons-material";

// ─── Import the new attendance calendar ──────────────────────────────────────
import AttendanceCalendar from "./AttendanceCalendar";
// ─── Import the DTR notice panel (absences / missing time-out / missing break) ──
import DtrNoticePanel from "./DtrNoticePanel";
// ─── Employee essentials widgets (action center, today, leave, SC, tickets…) ──
import EmployeeHomeWidgets, { EmployeeTodayCard } from "./EmployeeHomeWidgets";
import earistBg from "../assets/EaristBG.PNG";
import { broadcastRefreshDelay } from "../utils/realtimeRefresh";

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  accent: "#6d2323",
  accentDark: "#5a1d1d",
  accentMid: "#8B4545",
  accentFaint: "rgba(109,35,35,0.06)",
  accentBorder: "rgba(109,35,35,0.12)",
  accentHover: "rgba(109,35,35,0.10)",
  rowOdd: "rgba(109,35,35,0.025)",
  rowHover: "rgba(109,35,35,0.055)",
  text: "#1a1a1a",
  muted: "#6b6b6b",
  faint: "#a0a0a0",
  surface: "#ffffff",
  page: "#f3eee9",
  divider: "rgba(0,0,0,0.07)",
};

// ─── Shimmer keyframes ────────────────────────────────────────────────────────
const shimmerKf = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800&display=swap');
* { font-family: 'Poppins', sans-serif !important; }
@keyframes shimmer { 0% { background-position: -800px 0; } 100% { background-position: 800px 0; } }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.hris-home-dash .MuiCard-root {
  border: none !important;
  outline: none !important;
  box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 4px 12px rgba(15,23,42,0.06), 0 14px 28px rgba(15,23,42,0.07) !important;
  transition: box-shadow 0.22s ease, transform 0.22s ease !important;
}
.hris-home-dash .MuiCard-root:hover {
  transform: translateY(-2px);
  box-shadow: 0 0 0 1.5px rgba(109,35,35,0.22), 0 6px 16px rgba(15,23,42,0.08), 0 20px 40px rgba(15,23,42,0.12) !important;
}
`;

// ─── Shimmer bone ─────────────────────────────────────────────────────────────
const Bone = ({ w = "100%", h = 14, r = 6, sx = {} }) => (
  <Box sx={{ width: w, height: h, borderRadius: r, background: "linear-gradient(90deg,rgba(109,35,35,0.07) 25%,rgba(109,35,35,0.14) 50%,rgba(109,35,35,0.07) 75%)", backgroundSize: "800px 100%", animation: "shimmer 1.6s infinite linear", flexShrink: 0, ...sx }} />
);

// ─── Styled primitives ────────────────────────────────────────────────────────
const cardShadowRest = [
  "0 1px 2px rgba(15,23,42,0.04)",
  "0 4px 12px rgba(15,23,42,0.06)",
  "0 14px 28px rgba(15,23,42,0.07)",
].join(", ");
const cardShadowHover = [
  "0 0 0 1.5px rgba(109,35,35,0.22)",
  "0 6px 16px rgba(15,23,42,0.08)",
  "0 20px 40px rgba(15,23,42,0.12)",
].join(", ");

const SectionCard = styled(Card)({
  "&&": {
    borderRadius: 16,
    border: "0 !important",
    outline: "none",
    boxShadow: `${cardShadowRest} !important`,
    overflow: "hidden",
    background: "#fff",
    backgroundImage: "none",
    transition: "box-shadow 0.22s ease, transform 0.22s ease",
    willChange: "transform, box-shadow",
  },
  "&&:hover": {
    transform: "translateY(-2px)",
    boxShadow: `${cardShadowHover} !important`,
  },
});
SectionCard.defaultProps = { elevation: 0, variant: "elevation" };

const PanelHeader = ({ icon: Icon, title, right }) => (
  <Box sx={{ px: 1.75, py: 1.1, borderBottom: `1px solid ${T.divider}`, display: "flex", alignItems: "center", gap: 1, bgcolor: "#fff", minHeight: 44 }}>
    {Icon && (
      <Box sx={{ width: 26, height: 26, borderRadius: "8px", bgcolor: T.accentFaint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon sx={{ fontSize: 14, color: T.accent }} />
      </Box>
    )}
    <Typography sx={{ fontSize: "0.82rem", fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{title}</Typography>
    {right && (<><Box sx={{ flex: 1 }} />{right}</>)}
  </Box>
);

// ─── Flat tab component ───────────────────────────────────────────────────────
const FlatTab = ({ label, icon: Icon, badge, active, onClick }) => (
  <Box onClick={onClick} sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 0.75, py: 0.9, px: 1, cursor: "pointer", userSelect: "none", borderBottom: active ? `2px solid ${T.accent}` : "2px solid transparent", color: active ? T.accent : T.muted, bgcolor: "transparent", transition: "all 0.16s ease", "&:hover": { color: T.accent, bgcolor: T.accentFaint }, "&:active": { transform: "scale(0.98)" } }}>
    {Icon && <Icon sx={{ fontSize: 13, color: "inherit" }} />}
    <Typography sx={{ fontSize: "0.75rem", fontWeight: active ? 700 : 500, color: "inherit", lineHeight: 1 }}>{label}</Typography>
    {badge !== undefined && (
      <Box sx={{ fontSize: "0.6rem", fontWeight: 700, px: 0.75, py: 0.1, borderRadius: "99px", bgcolor: active ? `${T.accent}18` : `${T.accent}0D`, color: active ? T.accent : T.muted, lineHeight: 1.7, minWidth: 20, textAlign: "center", transition: "all 0.16s" }}>{badge}</Box>
    )}
  </Box>
);

// ─── Tab bar container ────────────────────────────────────────────────────────
const TabBar = ({ children, right }) => (
  <Box sx={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${T.divider}`, bgcolor: "#fff", px: 0.5, minHeight: 40, flexShrink: 0 }}>
    {children}
    {right && (<><Box sx={{ flex: 1 }} /><Box sx={{ display: "flex", alignItems: "center", pr: 0.75 }}>{right}</Box></>)}
  </Box>
);

// ─── System Settings ──────────────────────────────────────────────────────────
const useSystemSettings = () => {
  const [settings, setSettings] = useState({
    primaryColor: "#894444", secondaryColor: "#6d2323", accentColor: "#FEF9E1",
    textColor: "#FFFFFF", textPrimaryColor: "#6D2323", textSecondaryColor: "#FEF9E1",
    hoverColor: "#6D2323", backgroundColor: "#FFFFFF",
  });
  useEffect(() => {
    const stored = localStorage.getItem("systemSettings");
    if (stored) { try { setSettings(JSON.parse(stored)); } catch {} }
    const fetchSettings = async () => {
      try {
        const url = API_BASE_URL.includes("/api") ? `${API_BASE_URL}/system-settings` : `${API_BASE_URL}/api/system-settings`;
        const response = await axios.get(url);
        setSettings(response.data);
        localStorage.setItem("systemSettings", JSON.stringify(response.data));
      } catch {}
    };
    fetchSettings();
  }, []);
  return settings;
};

// ─── Carousel hook ────────────────────────────────────────────────────────────
const useCarousel = (items, autoPlay = true, interval = 5000) => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => {
    if (!isPlaying || !itemsRef.current || itemsRef.current.length === 0) return;
    const timer = setInterval(() => setCurrentSlide((s) => (s + 1) % itemsRef.current.length), interval);
    return () => clearInterval(timer);
  }, [isPlaying, interval, items.length]);
  const handlePrevSlide = useCallback(() => {
    if (!itemsRef.current?.length) return;
    setCurrentSlide((s) => (s - 1 + itemsRef.current.length) % itemsRef.current.length);
  }, []);
  const handleNextSlide = useCallback(() => {
    if (!itemsRef.current?.length) return;
    setCurrentSlide((s) => (s + 1) % itemsRef.current.length);
  }, []);
  const handleSlideSelect = useCallback((index) => {
    if (!itemsRef.current?.length) return;
    setCurrentSlide(index);
  }, []);
  const togglePlayPause = useCallback(() => setIsPlaying((prev) => !prev), []);
  return { currentSlide, isPlaying, handlePrevSlide, handleNextSlide, handleSlideSelect, togglePlayPause };
};

// ─── Shared expiry helpers ────────────────────────────────────────────────────
const isNotExpired = (date_end) => {
  if (!date_end) return true;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const e = new Date(date_end); e.setHours(0, 0, 0, 0);
  return today <= e;
};

// ─── Ticket Status Badge ──────────────────────────────────────────────────────
const TICKET_STATUS_STYLE = {
  new:        { bg: "#fef3c7", color: "#92400e", border: "#d97706" },
  read:       { bg: "#dbeafe", color: "#1e3a5f", border: "#2563eb" },
  replied:    { bg: "#dcfce7", color: "#14532d", border: "#16a34a" },
  on_process: { bg: "#ffedd5", color: "#7c2d12", border: "#fb923c" },
  resolved:   { bg: "#f3f4f6", color: "#374151", border: "#6b7280" },
};
const TICKET_STATUS_LABEL = { new: "New", read: "Read", replied: "Replied", on_process: "On Process", resolved: "Resolved" };

const TicketStatusBadge = ({ notifId, contactTicketStatuses }) => {
  const entry = (contactTicketStatuses || {})[notifId];
  const ticketStatus = (entry && typeof entry === "object" ? entry.status : entry) || "new";
  const s = TICKET_STATUS_STYLE[ticketStatus] || TICKET_STATUS_STYLE.new;
  return (
    <Box sx={{ px: 1.25, py: 0.2, bgcolor: s.bg, border: `1px solid ${s.border}`, borderRadius: "20px", display: "inline-flex", alignItems: "center" }}>
      <Typography sx={{ fontSize: "0.6rem", fontWeight: 900, color: s.color, letterSpacing: "0.08em", textTransform: "uppercase" }}>{TICKET_STATUS_LABEL[ticketStatus] || ticketStatus}</Typography>
    </Box>
  );
};

// ─── Wireframe Loading ────────────────────────────────────────────────────────
const WireframeLoading = () => (
  <>
    <style>{shimmerKf}</style>
    <Box sx={{ py: 2, px: { xs: 2, sm: 3, md: 6 }, width: "100vw", maxWidth: "100%", position: "relative", left: "55%", transform: "translateX(-53%)" }}>
      <Box sx={{ mb: 2, borderRadius: "12px", overflow: "hidden", border: "0.5px solid rgba(0,0,0,0.09)", animation: "blink 2s ease-in-out infinite" }}>
        <Box sx={{ px: 4, py: 3, background: "linear-gradient(135deg,#fdf5f5 0%,#f0dede 100%)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Box sx={{ width: 30, height: 30, borderRadius: "50%", bgcolor: "rgba(109,35,35,0.12)" }} />
            <Box><Bone w={220} h={16} sx={{ mb: 1 }} /><Bone w={300} h={11} /></Box>
          </Box>
          <Box sx={{ display: "flex", gap: 1 }}>
            {[1, 2, 3].map((i) => (<Box key={i} sx={{ width: 32, height: 32, borderRadius: "50%", bgcolor: T.accentFaint, border: `1px solid ${T.accentBorder}` }} />))}
          </Box>
        </Box>
      </Box>
      <Grid container spacing={2}>
        <Grid item xs={12} md={7}>
          <Box sx={{ height: "calc(100vh - 280px)", borderRadius: "12px", bgcolor: "#fff", border: "0.5px solid rgba(0,0,0,0.09)", animation: "blink 2s ease-in-out 0.15s infinite" }}>
            <Bone w="100%" h="100%" r={12} />
          </Box>
        </Grid>
        <Grid item xs={12} md={5}>
          <Box sx={{ display: "flex", gap: 1.5, height: "calc(100vh - 280px)" }}>
            {[1, 2].map((i) => (
              <Box key={i} sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 1.5 }}>
                <Box sx={{ height: 80, borderRadius: "12px", bgcolor: "#fff", border: "0.5px solid rgba(0,0,0,0.09)", p: 2, animation: "blink 2s ease-in-out 0.2s infinite" }}><Bone w="60%" h={12} sx={{ mb: 1 }} /></Box>
                <Box sx={{ height: 200, borderRadius: "12px", bgcolor: "#fff", border: "0.5px solid rgba(0,0,0,0.09)", p: 2, animation: "blink 2s ease-in-out 0.25s infinite" }}><Bone w="50%" h={12} sx={{ mb: 1 }} /></Box>
                <Box sx={{ flex: 1, borderRadius: "12px", bgcolor: "#fff", border: "0.5px solid rgba(0,0,0,0.09)", p: 2, animation: "blink 2s ease-in-out 0.3s infinite" }}><Bone w="40%" h={12} /></Box>
              </Box>
            ))}
          </Box>
        </Grid>
      </Grid>
    </Box>
  </>
);

// ─── Notification Filter Dropdown ─────────────────────────────────────────────
const NOTIF_FILTERS = [
  { key: "all",          label: "All" },
  { key: "unread",       label: "Unread" },
  { key: "payslip",      label: "Payslip" },
  { key: "contact",      label: "Tickets" },
  { key: "announcement", label: "Announcements" },
  { key: "holiday",      label: "Holidays" },
  { key: "suspension",   label: "Suspensions" },
];

const NotifFilterChips = ({ activeFilter, onChange, unreadCount }) => {
  const [anchorEl, setAnchorEl] = useState(null);
  const open = Boolean(anchorEl);
  const activeLabel = NOTIF_FILTERS.find((f) => f.key === activeFilter)?.label || "All";
  return (
    <>
      <Button onClick={(e) => setAnchorEl(e.currentTarget)} endIcon={<ArrowDropDown sx={{ fontSize: 15, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />}
        sx={{ minWidth: 74, height: 26, px: 0.85, py: 0.35, borderRadius: "8px", textTransform: "none", fontSize: "0.68rem", fontWeight: 500, color: "#fff", border: "1px solid rgba(255,255,255,0.28)", bgcolor: "rgba(255,255,255,0.15)", "&:hover": { bgcolor: "rgba(255,255,255,0.22)", borderColor: "rgba(255,255,255,0.32)" }, "& .MuiButton-endIcon": { ml: 0.3 } }}>
        {activeLabel}
      </Button>
      <Menu anchorEl={anchorEl} open={open} onClose={() => setAnchorEl(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}
        PaperProps={{ sx: { mt: 0.6, minWidth: 170, borderRadius: "10px", border: `1px solid ${T.accentBorder}`, boxShadow: "0 10px 28px rgba(0,0,0,0.14)", overflow: "hidden" } }}>
        {NOTIF_FILTERS.map(({ key, label }) => {
          const active = key === activeFilter;
          return (
            <MenuItem key={key} onClick={() => { onChange(key); setAnchorEl(null); }}
              sx={{ py: 0.9, fontSize: "0.74rem", color: active ? T.accent : T.text, fontWeight: active ? 700 : 400, bgcolor: active ? T.accentFaint : "transparent", "&:hover": { bgcolor: T.accentHover }, display: "flex", justifyContent: "space-between", gap: 1 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.8 }}>
                <Typography sx={{ fontSize: "0.74rem", fontWeight: "inherit" }}>{label}</Typography>
                {key === "unread" && unreadCount > 0 && <Typography sx={{ fontSize: "0.66rem", color: T.accent, fontWeight: 700 }}>{unreadCount}</Typography>}
              </Box>
              {active && <Box sx={{ width: 14, height: 14, borderRadius: "50%", bgcolor: T.accent, color: "#fff", fontSize: "0.62rem", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✓</Box>}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
};

// ─── Leave type icon/color mapping ────────────────────────────────────────────
const LEAVE_TYPE_STYLES = [
  { match: /adopt/i,                       icon: PeopleAltIcon,        bg: "#ececec", color: "#757575" },
  { match: /mandatory|forced/i,            icon: WorkIcon,             bg: "#d9cfc7", color: "#6d4c41" },
  { match: /rehab/i,                       icon: MedicalServicesIcon,  bg: "#d7f4f0", color: "#00897b" },
  { match: /special|emergency|calamity/i,  icon: WarningAmberIcon,     bg: "#ffe9c7", color: "#f57c00" },
  { match: /sick/i,                        icon: FavoriteIcon,         bg: "#fbdfe0", color: "#e5394f" },
  { match: /solo\s*parent/i,               icon: EscalatorWarningIcon, bg: "#d7e8fb", color: "#1976d2" },
  { match: /study/i,                       icon: SchoolIcon,           bg: "#e6ddf9", color: "#7b3fe4" },
  { match: /vacation/i,                    icon: BeachAccessIcon,      bg: "#d7f0e6", color: "#2e9e6c" },
  { match: /wellness/i,                    icon: SpaIcon,              bg: "#fde3ef", color: "#d6408c" },
  { match: /maternity|paternity/i,         icon: PregnantWomanIcon,    bg: "#fef0d0", color: "#c98a10" },
];
const FALLBACK_LEAVE_PALETTE = [
  { bg: "#ececec", color: "#757575" },
  { bg: "#d7e8fb", color: "#1976d2" },
  { bg: "#d7f4f0", color: "#00897b" },
  { bg: "#ffe9c7", color: "#f57c00" },
  { bg: "#fbdfe0", color: "#e5394f" },
  { bg: "#e6ddf9", color: "#7b3fe4" },
];
const getLeaveTypeStyle = (name, idx) => {
  const found = LEAVE_TYPE_STYLES.find((entry) => entry.match.test(name || ""));
  if (found) return found;
  const fallback = FALLBACK_LEAVE_PALETTE[idx % FALLBACK_LEAVE_PALETTE.length];
  return { icon: EventNoteIcon, ...fallback };
};

// ─── Home ─────────────────────────────────────────────────────────────────────
const Home = () => {
  const settings = useSystemSettings();
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const location = useLocation();
  const _pendingTicketId = useRef(null);

  const [pageLoading, setPageLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [announcements, setAnnouncements] = useState([]);
  const [suspensions, setSuspensions] = useState([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(true);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState(null);
  const [openModal, setOpenModal] = useState(false);
  const [profilePicture, setProfilePicture] = useState(null);
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [holidays, setHolidays] = useState([]);
  const [rawHolidays, setRawHolidays] = useState([]);
  const [allPayroll, setAllPayroll] = useState([]);
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [announcementDetails, setAnnouncementDetails] = useState({});
  const [contactTicketStatuses, setContactTicketStatuses] = useState({});
  const [leaveCredits, setLeaveCredits] = useState([]);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [notes, setNotes] = useState([]);
  const [events, setEvents] = useState([]);
  const [openNoteDialog, setOpenNoteDialog] = useState(false);
  const [openEventDialog, setOpenEventDialog] = useState(false);
  const [currentNote, setCurrentNote] = useState({ date: "", content: "" });
  const [currentEvent, setCurrentEvent] = useState({ date: "", title: "", description: "" });
  const [selectedDate, setSelectedDate] = useState("");
  const [viewNotesDialog, setViewNotesDialog] = useState(false);
  const [anchorEl, setAnchorEl] = useState(null);
  const openMenu = Boolean(anchorEl);
  const [calendarLegendAnchorEl, setCalendarLegendAnchorEl] = useState(null);
  const openCalendarLegend = Boolean(calendarLegendAnchorEl);
  const [payslipMonth, setPayslipMonth] = useState(new Date().getMonth());
  const [payslipYear, setPayslipYear] = useState(new Date().getFullYear());
  const [notifFilter, setNotifFilter] = useState("all");
  const [activePayslipTab, setActivePayslipTab] = useState(0);
  const HIDE_LEAVE_CREDITS_DISPLAY = false; // FALSE = Show leave credits, TRUE = Hide leave credits

  const month = calendarDate.getMonth();
  const year = calendarDate.getFullYear();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const payrollData = useMemo(() => {
    if (!allPayroll.length || !employeeNumber) return null;
    return allPayroll.find((p) => {
      if (!p.startDate) return false;
      const d = new Date(p.startDate);
      return String(p.employeeNumber) === String(employeeNumber) && d.getMonth() === payslipMonth && d.getFullYear() === payslipYear;
    }) || null;
  }, [allPayroll, employeeNumber, payslipMonth, payslipYear]);

  const latestPayroll = useMemo(() => {
    if (!allPayroll.length || !employeeNumber) return null;
    const mine = allPayroll
      .filter((p) => String(p.employeeNumber) === String(employeeNumber) && p.startDate)
      .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    return mine[0] || null;
  }, [allPayroll, employeeNumber]);

  const latestPayrollLabel = useMemo(() => {
    if (!latestPayroll?.startDate) return null;
    const d = new Date(latestPayroll.startDate);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }, [latestPayroll]);

  const payslipPeriodTotal = useMemo(() => {
    if (!payrollData) return null;
    const a = parseFloat(payrollData.pay1st) || 0;
    const b = parseFloat(payrollData.pay2nd) || 0;
    const sum = a + b;
    return sum > 0 ? sum : null;
  }, [payrollData]);

  const scheduledHolidaysForCarousel = useMemo(() =>
    (rawHolidays || []).filter((h) => (h.status || "").toLowerCase() === "active" && isNotExpired(h.date_end || h.date))
      .map((h) => ({ id: `holiday-${h.id}`, title: h.title || h.description || "", about: h.about || "Official holiday.", date: h.date_start || h.date_end || h.date, date_start: h.date_start || h.date, date_end: h.date_end || h.date, image: h.image || null })),
    [rawHolidays]);

  const suspensionsForCarousel = useMemo(() =>
    (suspensions || []).filter((s) => isNotExpired(s.date_end))
      .map((s) => ({ id: `suspension-${s.id}`, title: s.title || "", about: s.about || "", date: s.date_start || s.date_end || s.date, date_start: s.date_start || s.date, date_end: s.date_end || s.date, image: s.image || null })),
    [suspensions]);

  const announcementsInRange = useMemo(() => (announcements || []).filter((a) => isNotExpired(a.date_end)), [announcements]);

  const carouselItems = useMemo(() =>
    [...scheduledHolidaysForCarousel, ...suspensionsForCarousel, ...announcementsInRange]
      .sort((a, b) => new Date(b.date_start || b.date) - new Date(a.date_start || a.date)),
    [scheduledHolidaysForCarousel, suspensionsForCarousel, announcementsInRange]);

  const { currentSlide, isPlaying, handlePrevSlide, handleNextSlide, handleSlideSelect, togglePlayPause } = useCarousel(carouselItems);

  const fetchHolidays = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/holiday`);
      if (Array.isArray(res.data)) {
        setRawHolidays(res.data);
        setHolidays(res.data.map((item) => {
          const d = new Date(item.date);
          const normalizedDate = !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : item.date;
          return { date: normalizedDate, name: item.description, status: item.status };
        }));
      }
    } catch (err) { console.error("Error fetching holidays:", err); }
  }, []);

  const fetchSuspensions = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/suspensions`);
      setSuspensions(Array.isArray(res.data) ? res.data : []);
    } catch { setSuspensions([]); }
  }, []);

  const fetchAnnouncements = useCallback(async () => {
    setAnnouncementsLoading(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/announcements`);
      setAnnouncements(Array.isArray(res.data) ? res.data : []);
    } catch { setAnnouncements([]); }
    finally { setAnnouncementsLoading(false); }
  }, []);

  const normalizeDate = (date) => {
    if (!date) return null;
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const buildDateStr = (y, m, d) => {
    if (!d) return "";
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };

  useEffect(() => {
    const interval = setInterval(() => setCurrentDate(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchNotesAndEvents = async () => {
      if (!employeeNumber) return;
      try {
        const [notesRes, eventsRes] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/notes/${employeeNumber}`, getAuthHeaders()),
          axios.get(`${API_BASE_URL}/api/events/${employeeNumber}`, getAuthHeaders()),
        ]);
        setNotes((Array.isArray(notesRes.data) ? notesRes.data : []).map((n) => ({ ...n, date: normalizeDate(n.date) })));
        setEvents((Array.isArray(eventsRes.data) ? eventsRes.data : []).map((e) => ({ ...e, date: normalizeDate(e.date) })));
      } catch {
        setNotes(JSON.parse(localStorage.getItem("employeeNotes") || "[]"));
        setEvents(JSON.parse(localStorage.getItem("employeeEvents") || "[]"));
      }
    };
    fetchNotesAndEvents();
  }, [employeeNumber]);

  useEffect(() => {
    const fetchLeaveCredits = async () => {
      if (!employeeNumber) return;
      setLeaveLoading(true);
      try {
        const assignmentsRes = await axios.get(
          `${API_BASE_URL}/leaveRoute/leave_assignment/employee/${employeeNumber}`,
          getAuthHeaders(),
        );
        const userAssignments = Array.isArray(assignmentsRes.data) ? assignmentsRes.data : [];
        const byCode = {};
        userAssignments.forEach((a) => { if (!byCode[a.leave_code]) byCode[a.leave_code] = []; byCode[a.leave_code].push(a); });
        const grouped = Object.entries(byCode).map(([code, entries]) => {
          const leaveType = entries[0];
          const sorted = entries.sort((a, b) => {
            const yearDiff = (b.period_year || 0) - (a.period_year || 0);
            if (yearDiff !== 0) return yearDiff;
            const semVal = (s) => s?.includes("2nd") ? 2 : s?.includes("1st") ? 1 : 0;
            return semVal(b.period_semester) - semVal(a.period_semester);
          });
          const current = sorted[0];
          const previous = sorted.slice(1);
          const currRemaining = (parseFloat(current?.remaining_hours) || 0) / 8;
          const currTotal = (parseFloat(current?.total_hours) || 0) / 8;
          const currAllocated = (parseFloat(current?.allocated_hours) || parseFloat(current?.total_hours) || 0) / 8;
          const prevRemaining = previous.reduce((s, e) => s + (parseFloat(e.remaining_hours) || 0) / 8, 0);
          const prevTotal = previous.reduce((s, e) => s + (parseFloat(e.total_hours) || 0) / 8, 0);
          return { code, name: leaveType?.leave_description || current?.leave_description || code, grandRemaining: currRemaining + prevRemaining, grandTotal: currTotal + prevTotal, currRemaining, currTotal, currAllocated, prevRemaining, period: current?.period_year ? `${current.period_year}${current.period_semester ? ` ${current.period_semester}` : ""}` : null };
        });
        setLeaveCredits(grouped);
      } catch { setLeaveCredits([]); }
      finally { setLeaveLoading(false); }
    };
    fetchLeaveCredits();
  }, [employeeNumber]);

  const fetchNotifications = useCallback(async () => {
    const empNum = String(employeeNumber || resolveEmployeeNumber()).trim();
    if (!empNum) return;
    try {
      const notifRes = await axios.get(
        `${API_BASE_URL}/api/notifications/${empNum}`,
        getAuthHeaders(),
      );
      const filteredNotifications = sortNotificationsLatestFirst(
        scopeNotificationsToEmployee(extractNotificationList(notifRes.data), empNum).map(normalizeNotification),
      );
      setNotifications((prev) => {
        const localReadIds = new Set(prev.filter((n) => n.read_status === 1).map((n) => n.id));
        return filteredNotifications.map((n) => localReadIds.has(n.id) ? { ...n, read_status: 1 } : n);
      });
      const contactNotifs = filteredNotifications.filter((n) => n.notification_type === "contact" || n.notification_type === "ticket");
      if (contactNotifs.length > 0) {
        try {
          const ticketsRes = await axios.get(`${API_BASE_URL}/api/contact-us`, getAuthHeaders());
          const ticketList = ticketsRes.data?.data || ticketsRes.data || [];
          const ticketIdMap = {};
          ticketList.forEach((t) => { ticketIdMap[t.id] = t; });
          const notifStatusMap = {};
          contactNotifs.forEach((notif) => {
            const ticketId = parseNotificationTargetId(notif, "contact");
            const ticket = ticketId ? ticketIdMap[ticketId] : null;
            if (ticket) {
              notifStatusMap[notif.id] = { status: ticket.status, subject: ticket.subject || ticket.title || "", employee_name: ticket.employee_name || ticket.name || "", employee_number: ticket.employee_number || ticket.agencyEmployeeNum || "" };
            } else {
              const empTickets = ticketList.filter((t) => employeeNumbersMatch(t.employee_number, empNum));
              if (empTickets.length > 0) {
                const latest = empTickets.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0];
                notifStatusMap[notif.id] = { status: latest.status, subject: latest.subject || latest.title || "", employee_name: latest.employee_name || latest.name || "", employee_number: latest.employee_number || latest.agencyEmployeeNum || "" };
              }
            }
          });
          setContactTicketStatuses(notifStatusMap);
        } catch {}
      }
      const announcementNotifs = filteredNotifications.filter((n) => n.notification_type === "announcement");
      if (announcementNotifs.length > 0) {
        try {
          const annRes = await axios.get(`${API_BASE_URL}/api/announcements`, getAuthHeaders());
          const announcementList = Array.isArray(annRes.data) ? annRes.data : [];
          const detailsMap = {};
          announcementNotifs.forEach((notif) => {
            const targetId = parseNotificationTargetId(notif, "announcement");
            const announcement = findById(announcementList, targetId) || latestByDate(announcementList, ["date_start", "date", "id"]);
            if (announcement) detailsMap[notif.id] = announcement;
          });
          setAnnouncementDetails(detailsMap);
        } catch {}
      }
    } catch (err) {
      console.error("Error fetching notifications:", err);
    }
  }, [employeeNumber]);

  const fetchNotificationsRef = useRef(fetchNotifications);
  useEffect(() => { fetchNotificationsRef.current = fetchNotifications; }, [fetchNotifications]);
  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  useEffect(() => {
    if (!socket || !connected) return;
    const refreshTimeoutRef = { current: null };
    const scheduleRefresh = () => {
      if (refreshTimeoutRef.current) return;
      refreshTimeoutRef.current = setTimeout(() => { refreshTimeoutRef.current = null; if (typeof fetchNotificationsRef.current === "function") fetchNotificationsRef.current(); }, broadcastRefreshDelay());
    };
    const handleAnnouncementChanged = (payload) => {
      const { action, announcement } = payload;
      if (action === "created") setAnnouncements((prev) => prev.some((a) => a.id === announcement.id) ? prev : [announcement, ...prev]);
      else if (action === "updated") setAnnouncements((prev) => prev.map((a) => (a.id === announcement.id ? announcement : a)));
      else if (action === "deleted") { const deletedId = announcement?.id || announcement; setAnnouncements((prev) => prev.filter((a) => a.id !== deletedId)); }
    };
    const handleAdminDashboardUpdated = (payload) => {
      const { source } = payload;
      if (source === "holiday" || source === "suspensions" || source === "announcements") {
        fetchHolidays();
        fetchSuspensions();
        fetchAnnouncements();
      }
      scheduleRefresh();
    };
    const handleAnnouncementForNotifs = (payload) => {
      handleAnnouncementChanged(payload);
      scheduleRefresh();
    };
    socket.on("notificationCreated", scheduleRefresh);
    socket.on("payrollChanged", scheduleRefresh);
    socket.on("announcementChanged", handleAnnouncementForNotifs);
    socket.on("adminDashboardUpdated", handleAdminDashboardUpdated);
    return () => {
      socket.off("notificationCreated", scheduleRefresh);
      socket.off("payrollChanged", scheduleRefresh);
      socket.off("announcementChanged", handleAnnouncementForNotifs);
      socket.off("adminDashboardUpdated", handleAdminDashboardUpdated);
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    };
  }, [socket, connected, fetchHolidays, fetchSuspensions, fetchAnnouncements]);

  const openDetailFromNotification = (item) => {
    if (!item) {
      setNotifModalOpen(false);
      return;
    }
    setNotifModalOpen(false);
    // Defer so the notifications Modal can unmount before the detail Modal opens
    // (avoids MUI dual-modal focus/aria-hidden leaving a blank screen).
    window.setTimeout(() => {
      setSelectedAnnouncement(item);
      setOpenModal(true);
    }, 200);
  };

  const mapHolidayToDetail = (h) =>
    h
      ? {
          id: `holiday-${h.id}`,
          title: h.title || h.description || "",
          about: h.about || "Official holiday.",
          date: h.date_start || h.date_end || h.date,
          date_start: h.date_start || h.date,
          date_end: h.date_end || h.date,
          image: h.image || null,
        }
      : null;

  const mapSuspensionToDetail = (s) =>
    s
      ? {
          id: `suspension-${s.id}`,
          title: s.title || "",
          about: s.about || "",
          date: s.date_start || s.date_end || s.date,
          date_start: s.date_start || s.date,
          date_end: s.date_end || s.date,
          image: s.image || null,
        }
      : null;

  const handleNotificationClick = async (notification) => {
    if (notification.read_status === 0) {
      try {
        await axios.put(
          `${API_BASE_URL}/api/notifications/${notification.id}/read`,
          {},
          getAuthHeaders(),
        );
        setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, read_status: 1 } : n)));
      } catch {}
    }
    const type = inferNotificationType(notification);
    const link = notification.action_link || "";
    if (type === "payslip" || link.includes("payslip")) {
      setNotifModalOpen(false); navigate("/payslip");
    } else if (type === "contact" || type === "ticket" || link.includes("settings")) {
      setNotifModalOpen(false);
      const ticketIdFromLink = parseNotificationTargetId(notification, "contact");
      const statusMatch = (notification.action_link || "").match(/[?&]status=([^&]+)/);
      const ticketStatusFromLink = statusMatch ? statusMatch[1] : null;
      navigate("/settings", { state: { section: "contact", ticketId: ticketIdFromLink, ticketStatus: ticketStatusFromLink } });
    } else if (type === "announcement" || link.includes("announcement")) {
      try {
        const targetId = parseNotificationTargetId(notification, "announcement");
        let match =
          findById(announcements, targetId) ||
          announcementDetails[notification.id] ||
          null;
        if (!match) {
          const annRes = await axios.get(`${API_BASE_URL}/api/announcements`, getAuthHeaders());
          const list = Array.isArray(annRes.data) ? annRes.data : [];
          match = findById(list, targetId) || latestByDate(list, ["date_start", "date", "id"]);
        }
        openDetailFromNotification(match);
      } catch {
        setNotifModalOpen(false);
      }
    } else if (type === "holiday") {
      const targetId = parseNotificationTargetId(notification, "holiday");
      const match =
        mapHolidayToDetail(findById(rawHolidays, targetId)) ||
        getCarouselItemForNotif(notification) ||
        mapHolidayToDetail(latestByDate(rawHolidays, ["date_start", "date", "id"]));
      openDetailFromNotification(match);
    } else if (type === "suspension") {
      const targetId = parseNotificationTargetId(notification, "suspension");
      const match =
        mapSuspensionToDetail(findById(suspensions, targetId)) ||
        getCarouselItemForNotif(notification) ||
        mapSuspensionToDetail(latestByDate(suspensions, ["date_start", "date", "id"]));
      openDetailFromNotification(match);
    } else if (type === "leave") {
      setNotifModalOpen(false);
      navigate("/leave-request-user");
    } else if (link) {
      setNotifModalOpen(false);
      if (link.includes("/settings/contact/")) {
        const contactMatch = link.match(/\/settings\/contact\/(\d+)/);
        const statusMatch = link.match(/[?&]status=([^&]+)/);
        navigate("/settings", {
          state: {
            section: "contact",
            ticketId: contactMatch ? Number(contactMatch[1]) : null,
            ticketStatus: statusMatch ? statusMatch[1] : null,
          },
        });
      } else {
        navigate(link);
      }
    }
  };

  const getUserInfo = () => {
    const token = localStorage.getItem("token");
    if (!token) return { employeeNumber: resolveEmployeeNumber() };
    try {
      const decoded = JSON.parse(atob(token.split(".")[1]));
      return {
        role: decoded.role,
        employeeNumber: decoded.employeeNumber || resolveEmployeeNumber(),
        username: decoded.username,
      };
    }
    catch { return { employeeNumber: resolveEmployeeNumber() }; }
  };

  useEffect(() => {
    const userInfo = getUserInfo();
    if (userInfo.username) setUsername(userInfo.username);
    if (userInfo.employeeNumber) setEmployeeNumber(userInfo.employeeNumber);
  }, []);

  useEffect(() => {
    const fetchPayrollData = async () => {
      if (!employeeNumber) return;
      try {
        const res = await axios.get(
          `${API_BASE_URL}/PayrollReleasedRoute/released-payroll-detailed`,
          getAuthHeaders(),
        );
        setAllPayroll(Array.isArray(res.data) ? res.data : []);
      } catch {}
    };
    fetchPayrollData();
  }, [employeeNumber]);

  useEffect(() => {
    const init = async () => {
      await Promise.allSettled([fetchAnnouncements(), fetchHolidays(), fetchSuspensions()]);
      setTimeout(() => setPageLoading(false), 400);
    };
    init();
  }, [fetchAnnouncements, fetchHolidays, fetchSuspensions]);

  useEffect(() => {
    const fetchProfilePicture = async () => {
      if (!employeeNumber) return;
      try {
        const res = await axios.get(
          `${API_BASE_URL}/personalinfo/person_table/${employeeNumber}`,
          getAuthHeaders(),
        );
        const data = Array.isArray(res.data) ? (res.data[0] ?? {}) : (res.data ?? {});
        if (data.profile_picture) setProfilePicture(data.profile_picture);
        const fullNameFromPerson = `${data.firstName || ""} ${data.middleName || ""} ${data.lastName || ""} ${data.nameExtension || ""}`.trim();
        if (fullNameFromPerson) setFullName(fullNameFromPerson);
      } catch {}
    };
    fetchProfilePicture();
  }, [employeeNumber]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; document.documentElement.style.overflow = ""; };
  }, []);

  const generateCalendar = () => {
    const days = [];
    const adjustedFirstDay = firstDay === 0 ? 6 : firstDay - 1;
    for (let i = 0; i < adjustedFirstDay; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(d);
    while (days.length < 42) days.push(null);
    return days;
  };
  const calendarDays = generateCalendar();

  const isDateInHolidayRange = useCallback((dateStr) => {
    if (!dateStr) return null;
    const check = new Date(dateStr);
    check.setHours(0, 0, 0, 0);
    for (const raw of rawHolidays) {
      if ((raw.status || "").toLowerCase() !== "active") continue;
      const startRaw = raw.date_start || raw.date;
      const endRaw = raw.date_end || raw.date;
      if (!startRaw) continue;
      const start = new Date(startRaw);
      const end = new Date(endRaw);
      start.setHours(0, 0, 0, 0);
      end.setHours(0, 0, 0, 0);
      if (check >= start && check <= end) {
        return { name: raw.description || raw.title || "", status: raw.status };
      }
    }
    return null;
  }, [rawHolidays]);

  const getAnnouncementsForDate = useCallback((dateStr) =>
    Array.isArray(announcements) ? announcements.filter((a) => normalizeDate(a.date) === dateStr) : [],
    [announcements]);

  const handleAddNote = () => { if (!selectedDate) return; setCurrentNote({ date: selectedDate, content: "" }); setOpenNoteDialog(true); };
  const handleSaveNote = async () => {
    try {
      const res = await axios.post(
        `${API_BASE_URL}/api/notes`,
        { employee_number: employeeNumber, date: currentNote.date, content: currentNote.content },
        getAuthHeaders(),
      );
      const normalizedNote = { ...res.data, date: normalizeDate(res.data.date) };
      setNotes((prev) => [...prev, normalizedNote]);
      localStorage.setItem("employeeNotes", JSON.stringify([...notes, normalizedNote]));
    } catch {
      const newNote = { id: Date.now(), date: currentNote.date, content: currentNote.content, createdAt: new Date().toISOString() };
      const updated = [...notes, newNote]; setNotes(updated); localStorage.setItem("employeeNotes", JSON.stringify(updated));
    }
    setOpenNoteDialog(false); setCurrentNote({ date: "", content: "" });
  };
  const handleDeleteNote = async (noteId) => {
    try { await axios.delete(`${API_BASE_URL}/api/notes/${noteId}`, getAuthHeaders()); } catch {}
    const updated = notes.filter((n) => n.id !== noteId); setNotes(updated); localStorage.setItem("employeeNotes", JSON.stringify(updated));
  };
  const handleAddEvent = () => { if (!selectedDate) return; setCurrentEvent({ date: selectedDate, title: "", description: "" }); setOpenEventDialog(true); };
  const handleSaveEvent = async () => {
    try {
      const res = await axios.post(
        `${API_BASE_URL}/api/events`,
        { employee_number: employeeNumber, date: currentEvent.date, title: currentEvent.title, description: currentEvent.description },
        getAuthHeaders(),
      );
      const normalizedEvent = { ...res.data, date: normalizeDate(res.data.date) };
      setEvents((prev) => [...prev, normalizedEvent]);
      localStorage.setItem("employeeEvents", JSON.stringify([...events, normalizedEvent]));
    } catch {
      const newEvent = { id: Date.now(), date: currentEvent.date, title: currentEvent.title, description: currentEvent.description, createdAt: new Date().toISOString() };
      const updated = [...events, newEvent]; setEvents(updated); localStorage.setItem("employeeEvents", JSON.stringify(updated));
    }
    setOpenEventDialog(false); setCurrentEvent({ date: "", title: "", description: "" });
  };
  const handleDeleteEvent = async (eventId) => {
    try { await axios.delete(`${API_BASE_URL}/api/events/${eventId}`, getAuthHeaders()); } catch {}
    const updated = events.filter((e) => e.id !== eventId); setEvents(updated); localStorage.setItem("employeeEvents", JSON.stringify(updated));
  };
  const getNotesForDate = (dateStr) => notes.filter((n) => n.date === dateStr);
  const getEventsForDate = (dateStr) => events.filter((e) => e.date === dateStr);
  const getRecentActivity = () => {
    const all = [
      ...notes.map((note) => ({ id: note.id, type: "note", title: "Note", content: note.content, date: note.date, createdAt: note.createdAt || new Date().toISOString() })),
      ...events.map((event) => ({ id: event.id, type: "event", title: event.title, content: event.description, date: event.date, createdAt: event.createdAt || new Date().toISOString() })),
    ];
    return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  };

  const handleMenuOpen = (event) => setAnchorEl(event.currentTarget);
  const handleMenuClose = () => setAnchorEl(null);
  const handleOpenModal = (announcement) => { setSelectedAnnouncement(announcement); setOpenModal(true); };
  const handleCloseModal = () => { setOpenModal(false); setSelectedAnnouncement(null); };
  const handleLogout = () => { localStorage.removeItem("token"); navigate("/login"); };

  const derivedUnreadCount = notifications.filter((n) => n.read_status === 0).length;
  const totalLeave = leaveCredits.reduce((s, g) => s + g.currRemaining + g.prevRemaining, 0);

  const getCarouselItemForNotif = useCallback((notif) => {
    try {
      const type = inferNotificationType(notif);
      if (type === "announcement") {
        return announcementDetails[notif.id] || findById(announcements, parseNotificationTargetId(notif, "announcement")) || null;
      }
      if (type === "holiday") {
        const id = parseNotificationTargetId(notif, "holiday");
        return mapHolidayToDetail(findById(rawHolidays, id)) || scheduledHolidaysForCarousel[0] || mapHolidayToDetail(latestByDate(rawHolidays));
      }
      if (type === "suspension") {
        const id = parseNotificationTargetId(notif, "suspension");
        return mapSuspensionToDetail(findById(suspensions, id)) || suspensionsForCarousel[0] || mapSuspensionToDetail(latestByDate(suspensions));
      }
    } catch {
      return null;
    }
    return null;
  }, [announcementDetails, announcements, rawHolidays, suspensions, scheduledHolidaysForCarousel, suspensionsForCarousel]);

  const filteredNotifications = useMemo(() => {
    if (!Array.isArray(notifications)) return [];
    return notifications.filter((n) => {
      const type = inferNotificationType(n);
      if (notifFilter === "all") return true;
      if (notifFilter === "unread") return n.read_status === 0;
      if (notifFilter === "contact") return type === "contact" || type === "ticket";
      return type === notifFilter;
    });
  }, [notifications, notifFilter]);

  const getNotificationDayLabel = useCallback((createdAt) => {
    if (!createdAt) return "Earlier";
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return "Earlier";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() === today.getTime()) return "Today";
    if (d.getTime() === yesterday.getTime()) return "Yesterday";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }, []);

  const markAllNotificationsAsRead = useCallback(async () => {
    const unread = (notifications || []).filter((n) => n.read_status === 0);
    if (!unread.length) return;
    const auth = getAuthHeaders();
    try {
      await Promise.allSettled(
        unread.map((n) =>
          axios.put(`${API_BASE_URL}/api/notifications/${n.id}/read`, {}, auth),
        ),
      );
    } finally {
      setNotifications((prev) => prev.map((n) => (n.read_status === 0 ? { ...n, read_status: 1 } : n)));
    }
  }, [notifications]);

  const handleCloseNotifModal = () => { setNotifModalOpen(false); setNotifFilter("all"); };

  const fmt = (val) => {
    const n = parseFloat(val);
    return !isNaN(n) && n !== 0 ? `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "₱0.00";
  };

  if (pageLoading) {
    return (
      <Box sx={{ width: "100vw", maxWidth: "100%", position: "relative", left: "50%", transform: "translateX(-50%)" }}>
        <WireframeLoading />
      </Box>
    );
  }

  return (
    <Fade in timeout={500}>
      <Box className="hris-home-dash" sx={{ width: "100vw", maxWidth: "100%", position: "relative", left: "55%", transform: "translateX(-53.5%)", minHeight: "100vh" }}>
        <style>{shimmerKf}</style>
        <Box sx={{ pb: 8, px: { xs: 1.5, md: 2 }, mx: "auto" }}>

          {/* ── HEADER ── */}
          <SectionCard sx={{ mb: 1.5, "&&": { background: "transparent", backgroundImage: "none" }, borderRadius: "12px", overflow: "hidden" }}>
            <Box sx={{
              px: 2.5, py: 1.5,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              position: "relative", overflow: "hidden",
              background: "linear-gradient(105deg, #6d2323 0%, #8f3034 48%, #b34a4f 100%)",
              borderTop: `2.5px solid ${T.accent}`,
              minHeight: 72,
            }}>
              {/* Building watermark */}
              <Box
                component="img"
                src={earistBg}
                alt=""
                aria-hidden
                sx={{
                  position: "absolute",
                  right: { xs: -16, md: 0 },
                  top: "140%",
                  transform: "translateY(-50%)",
                  height: "320%",
                  width: { xs: "55%", md: "42%" },
                  objectFit: "cover",
                  objectPosition: "center right",
                  opacity: 0.75,
                  pointerEvents: "none",
                  maskImage: "linear-gradient(to left, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.45) 55%, transparent 100%)",
                  WebkitMaskImage: "linear-gradient(to left, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.45) 55%, transparent 100%)",
                  // Clip the image to the rounded header shape to avoid visual "bleed" at the edges
                  borderRadius: 2,
                  clipPath: "inset(0 round 12px)",
                }}
              />
              <Box
                sx={{
                  position: "absolute", inset: 0, pointerEvents: "none",
                  background: "linear-gradient(90deg, rgba(74,17,19,0.48) 0%, rgba(109,35,35,0.18) 55%, rgba(109,35,35,0.04) 100%)",
                }}
              />

              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, position: "relative", zIndex: 1, minWidth: 0 }}>
                <Box sx={{
                  width: 36, height: 36, borderRadius: "10px", flexShrink: 0,
                  background: "rgba(255,255,255,0.16)",
                  border: "1px solid rgba(255,255,255,0.30)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 2px 8px rgba(52,8,10,0.24)",
                }}>
                  <WbSunnyIcon sx={{ fontSize: 20, color: "#fff3cf" }} />
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: "1.05rem", fontWeight: 800, color: "#fff", lineHeight: 1.2 }}>
                    Hello, <span style={{ color: "#fff" }}>{fullName || username}</span>
                  </Typography>
                  {/* <Typography sx={{ fontSize: "0.72rem", color: "rgba(255,255,255,0.82)", fontWeight: 500, display: "flex", alignItems: "center", gap: 0.5, mt: 0.25, flexWrap: "wrap" }}>
                    <AccessTimeIcon sx={{ fontSize: 13 }} />
                    {currentDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                  </Typography> */}
                </Box>
              </Box>

              <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", position: "relative", zIndex: 1, flexShrink: 0 }}>
                <Typography
                  sx={{
                    display: { xs: "none", lg: "block" },
                    fontFamily: '"Brush Script MT", "Segoe Script", cursive !important',
                    fontSize: "1.35rem",
                    fontWeight: 400,
                    color: "#ffe0aa",
                    letterSpacing: "0.02em",
                    whiteSpace: "nowrap",
                    mr: 0.5,
                    lineHeight: 1,
                    textShadow: "0 1px 2px rgba(56,8,10,0.38)",
                  }}
                >
                  {/* E.A.R.I.S.T as One */}
                </Typography>
                {/* <Tooltip title="Refresh data">
                  <button
                    onClick={() => { fetchAnnouncements(); fetchHolidays(); fetchSuspensions(); }}
                    style={{ background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.28)", borderRadius: "8px", padding: "7px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: "#fff", fontSize: "0.75rem", fontWeight: 700, fontFamily: "inherit", transition: "all 0.15s" }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.24)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.14)"; }}
                  >
                    <AutorenewIcon sx={{ fontSize: 15 }} />
                    Refresh
                  </button>
                </Tooltip> */}
                <Tooltip title="Notifications">
  <IconButton
    size="small"
    onClick={async () => { setNotifModalOpen(true); await fetchNotifications(); }}
    sx={{
      bgcolor: "#ffffff",
      border: "1px solid rgba(255,255,255,0.9)",
      color: T.accent,
      borderRadius: "8px",
      width: 36,
      height: 36,
      "&:hover": { bgcolor: "rgba(255,255,255,0.85)" },
    }}
  >
    <Badge badgeContent={derivedUnreadCount} color="error" max={9}>
      <NotificationsIcon sx={{ fontSize: 18 }} />
    </Badge>
  </IconButton>
</Tooltip>

<Box sx={{
  position: "relative",
  "&::before": {
    content: '""',
    position: "absolute",
    inset: -2,
    borderRadius: "50%",
    padding: "2px",
    background: "#ffffff",
    WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
    WebkitMaskComposite: "xor",
    maskComposite: "exclude",
  }
}}>
  <IconButton onClick={handleMenuOpen} sx={{ p: 0.5 }}>
    <Avatar alt={username} src={profilePicture ? `${API_BASE_URL}${profilePicture}` : undefined} sx={{ width: 36, height: 36 }} />
  </IconButton>
</Box>
                <Menu anchorEl={anchorEl} open={openMenu} onClose={handleMenuClose} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}
                  PaperProps={{ sx: { borderRadius: 2, minWidth: 180, bgcolor: "#fff", border: `1px solid ${T.accentBorder}`, boxShadow: "0 12px 32px rgba(0,0,0,0.12)", "& .MuiMenuItem-root": { fontSize: "0.875rem", color: T.text, "&:hover": { background: T.accentFaint } } } }}>
                  <MenuItem onClick={() => { handleMenuClose(); navigate("/profile"); }}><AccountCircle sx={{ mr: 1, fontSize: 18, color: T.accent }} /> Profile</MenuItem>
                  <MenuItem onClick={() => { handleMenuClose(); navigate("/settings"); }}><Settings sx={{ mr: 1, fontSize: 18, color: T.accent }} /> Settings</MenuItem>
                  <MenuItem onClick={() => { handleMenuClose(); navigate("/faqs"); }}><HelpOutline sx={{ mr: 1, fontSize: 18, color: T.accent }} /> FAQs</MenuItem>
                  <MenuItem onClick={() => { handleMenuClose(); navigate("/privacy-policy"); }}><PrivacyTip sx={{ mr: 1, fontSize: 18, color: T.accent }} /> Privacy Policy</MenuItem>
                  <Divider sx={{ borderColor: T.divider }} />
                  <MenuItem onClick={() => { handleMenuClose(); handleLogout(); }}><Logout sx={{ mr: 1, fontSize: 18, color: T.accent }} /> Sign Out</MenuItem>
                </Menu>
              </Box>
            </Box>
          </SectionCard>

          {/* ── MAIN GRID ── */}
          <Grid container spacing={2} sx={{ flex: 1, minHeight: 0 }}>

            {/* ══ LEFT COLUMN: Carousel + Attendance Calendar ══ */}
<Grid item xs={12} md={4.5} sx={{ 
  display: "flex", 
  flexDirection: "column", 
  gap: 2, 
  minHeight: 0,
  overflow: "visible",
  minWidth: 0,
  height: { xs: "auto", md: "calc(100vh - 250px)" },
}}>
              {/* Carousel */}
              <SectionCard sx={{ height: { xs: "62vw", md: "62%" }, minHeight: 320, position: "relative", overflow: "hidden", flexShrink: 0 }}>
                <Box sx={{ position: "relative", height: "100%" }}>
                  {announcementsLoading ? (
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 2 }}>
                      <CircularProgress size={40} sx={{ color: T.accent }} />
                      <Typography sx={{ color: T.muted, fontSize: "0.85rem" }}>Loading announcements...</Typography>
                    </Box>
                  ) : carouselItems.length > 0 ? (
                    <Fade in key={currentSlide} timeout={{ enter: 800, exit: 400 }}>
                      <Box sx={{ position: "relative", height: "100%", width: "100%" }}>
                        <Box component="img" src={carouselItems[currentSlide]?.image ? `${API_BASE_URL}${carouselItems[currentSlide].image}` : "/api/placeholder/800/400"} alt={carouselItems[currentSlide]?.title || "Announcement"} sx={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        <Box sx={{
                          position: "absolute", inset: 0, pointerEvents: "none",
                          background: `
                            linear-gradient(115deg,
                              rgba(55, 8, 8, 0.94) 0%,
                              rgba(90, 20, 20, 0.82) 28%,
                              rgba(109, 35, 35, 0.45) 52%,
                              rgba(109, 35, 35, 0.12) 72%,
                              rgba(0, 0, 0, 0) 88%
                            ),
                            linear-gradient(to top,
                              rgba(40, 5, 5, 0.55) 0%,
                              rgba(40, 5, 5, 0.15) 35%,
                              transparent 60%
                            )
                          `,
                        }} />
                        <IconButton onClick={(e) => { e.stopPropagation(); handlePrevSlide(); }} sx={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", bgcolor: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.18)", "&:hover": { bgcolor: "#fff", transform: "translateY(-50%) scale(1.05)" }, color: T.accent, zIndex: 10, width: 34, height: 34 }}><ArrowBackIosNewIcon sx={{ fontSize: 13 }} /></IconButton>
                        <IconButton onClick={(e) => { e.stopPropagation(); handleNextSlide(); }} sx={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", bgcolor: "rgba(255,255,255,0.92)", boxShadow: "0 2px 8px rgba(0,0,0,0.18)", "&:hover": { bgcolor: "#fff", transform: "translateY(-50%) scale(1.05)" }, color: T.accent, zIndex: 10, width: 34, height: 34 }}><ArrowForwardIosIcon sx={{ fontSize: 13 }} /></IconButton>
                        <IconButton onClick={(e) => { e.stopPropagation(); togglePlayPause(); }} sx={{ position: "absolute", top: 14, right: 14, bgcolor: "rgba(255,255,255,0.88)", boxShadow: "0 2px 8px rgba(0,0,0,0.14)", "&:hover": { bgcolor: "#fff" }, color: T.accent, zIndex: 10, width: 28, height: 28 }}>{isPlaying ? <Pause sx={{ fontSize: 14 }} /> : <PlayArrow sx={{ fontSize: 14 }} />}</IconButton>
                        <Box onClick={() => handleOpenModal(carouselItems[currentSlide])} sx={{ position: "absolute", bottom: 0, left: 0, right: 0, p: 2.25, pr: 8, color: "#fff", cursor: "pointer", zIndex: 10 }}>
                          <Box sx={{ display: "inline-flex", alignItems: "center", px: 1.25, py: 0.3, borderRadius: "8px", bgcolor: "rgba(80,15,15,0.85)", border: "0.5px solid rgba(255,255,255,0.18)", mb: 1 }}>
                            <Typography sx={{ fontSize: "0.58rem", fontWeight: 700, color: "#fff", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                              {carouselItems[currentSlide]?.id?.toString().startsWith("holiday-") ? "Holiday" : carouselItems[currentSlide]?.id?.toString().startsWith("suspension-") ? "Suspension" : "Announcement"}
                            </Typography>
                          </Box>
                          <Typography sx={{ fontWeight: 800, mb: 0.45, lineHeight: 1.2, textShadow: "0 2px 10px rgba(0,0,0,0.35)", fontSize: { xs: "0.95rem", md: "1.15rem" } }}>{carouselItems[currentSlide]?.title}</Typography>
                          <Typography sx={{ opacity: 0.9, fontSize: "0.72rem", display: "flex", alignItems: "center", gap: 0.75 }}>
                            <AccessTimeIcon sx={{ fontSize: 12 }} />
                            {(() => { const raw = carouselItems[currentSlide]?.date; if (!raw) return ""; const d = new Date(raw); return isNaN(d) ? raw : d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }); })()}
                          </Typography>
                        </Box>
                        <Box sx={{ position: "absolute", bottom: 16, right: 16, display: "flex", gap: 0.75, alignItems: "center", zIndex: 10 }}>
                          {carouselItems.map((_, idx) => (
                            <Box key={idx} onClick={(e) => { e.stopPropagation(); handleSlideSelect(idx); }}
                              sx={{
                                width: currentSlide === idx ? 22 : 8, height: 8, borderRadius: 4,
                                bgcolor: currentSlide === idx ? "#fff" : "transparent",
                                border: currentSlide === idx ? "none" : "1.5px solid rgba(255,255,255,0.85)",
                                transition: "all 0.3s ease", cursor: "pointer",
                                "&:hover": { bgcolor: currentSlide === idx ? "#fff" : "rgba(255,255,255,0.35)" },
                              }} />
                          ))}
                        </Box>
                      </Box>
                    </Fade>
                  ) : (
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 2 }}>
                      <Flag sx={{ fontSize: 64, color: T.accentBorder }} />
                      <Typography sx={{ fontSize: "0.9rem", color: T.muted }}>No announcements currently available.</Typography>
                    </Box>
                  )}
                </Box>
              </SectionCard>

{/* ══ ATTENDANCE CALENDAR — below the carousel ══ */}
<Box sx={{
  flex: 1,
  minHeight: 180,
  minWidth: 0,
  width: "100%",
  display: "flex",
  overflow: "visible",
}}>
  <AttendanceCalendar
    employeeNumber={employeeNumber}
    holidays={rawHolidays}
  />
</Box>

            </Grid>

            {/* ══ RIGHT COLUMN ══ */}
            <Grid item xs={12} md={7.5} sx={{ height: { xs: "auto", md: "calc(100vh - 250px)" }, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, height: "100%", overflow: "visible" }}>

                {/* Top: Payslip + Today + Mini Calendar */}
                <Box sx={{ display: "flex", flexDirection: "row", gap: 2, flexShrink: 0, alignItems: "stretch", height: { md: 220 } }}>

                    {/* Payslip */}
                    <SectionCard sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <PanelHeader
                        icon={Receipt}
                        title="Payslip"
                        right={
                          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }} onClick={(e) => e.stopPropagation()}>
                            <Box sx={{
                              px: 0.85, py: 0.15, borderRadius: "99px", fontSize: "0.58rem", fontWeight: 700,
                              bgcolor: payrollData ? "rgba(46,125,50,0.12)" : "rgba(109,35,35,0.10)",
                              color: payrollData ? "#2e7d32" : T.accent,
                              border: `1px solid ${payrollData ? "rgba(46,125,50,0.28)" : "rgba(109,35,35,0.18)"}`,
                            }}>
                              {payrollData ? "Ready" : "Pending"}
                            </Box>
                            <FormControl size="small" variant="outlined" sx={{ minWidth: 96, "& .MuiOutlinedInput-root": { fontSize: "0.68rem", borderRadius: 2, height: 24, color: T.text, "& fieldset": { borderColor: T.accentBorder }, "&:hover fieldset": { borderColor: T.accent }, "&.Mui-focused fieldset": { borderColor: T.accent } }, "& .MuiSelect-icon": { color: T.accent, fontSize: 16 } }}>
                              <Select value={payslipMonth} onChange={(e) => setPayslipMonth(Number(e.target.value))} MenuProps={{ PaperProps: { sx: { borderRadius: 2, mt: 0.5, bgcolor: "#fff", border: `1px solid ${T.accentBorder}`, maxHeight: 220 } } }}>
                                {monthNames.map((name, i) => (<MenuItem key={i} value={i} sx={{ fontSize: "0.72rem", color: T.text, py: 0.5, fontWeight: payslipMonth === i ? 700 : 400, bgcolor: payslipMonth === i ? T.accentFaint : "transparent", "&:hover": { bgcolor: T.accentHover } }}>{name}</MenuItem>))}
                              </Select>
                            </FormControl>
                          </Box>
                        }
                      />
                      <Box onClick={() => navigate("/payslip", { state: { selectedMonth: payslipMonth, selectedYear: payslipYear } })}
                        sx={{ p: 1.25, flex: 1, cursor: "pointer", transition: "background 0.15s", "&:hover": { background: T.accentFaint }, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                        <Grid container spacing={0.75}>
                          {[{ label: "1st Quinceña", key: "pay1st" }, { label: "2nd Quinceña", key: "pay2nd" }].map(({ label, key }) => (
                            <Grid item xs={6} key={key}>
                              <Box sx={{ bgcolor: "#f7f5f4", border: "1px solid rgba(0,0,0,0.06)", borderRadius: "10px", p: 1.1 }}>
                                <Typography sx={{ color: T.faint, fontSize: "0.55rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", mb: 0.25 }}>{label}</Typography>
                                <Typography sx={{ color: payrollData ? T.accent : T.muted, fontWeight: 800, fontSize: "0.92rem", lineHeight: 1, letterSpacing: payrollData ? 0 : "0.04em" }}>
                                  {payrollData ? fmt(payrollData[key]) : "₱ - - -"}
                                </Typography>
                              </Box>
                            </Grid>
                          ))}
                        </Grid>
                        <Box sx={{ mt: "auto", pt: 0.85 }}>
                          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: 0.25 }}>
                            <Typography sx={{ fontSize: "0.6rem", color: T.muted, fontWeight: 600 }}>Total</Typography>
                            <Typography sx={{ fontSize: "0.78rem", fontWeight: 800, color: payrollData ? T.accent : T.muted }}>
                              {payslipPeriodTotal != null ? fmt(payslipPeriodTotal) : "\u20B1 - - -"}
                            </Typography>
                          </Box>
                          {!payrollData && (
                            <Box sx={{
                              display: "flex", alignItems: "center", gap: 0.75,
                              mt: 0.75, py: 0.7, px: 1, borderRadius: "8px",
                              bgcolor: "rgba(109,35,35,0.08)", border: "1px solid rgba(109,35,35,0.12)",
                            }}>
                              <InfoOutlinedIcon sx={{ fontSize: 14, color: T.accent, flexShrink: 0 }} />
                              <Typography sx={{ fontSize: "0.62rem", color: T.accent, fontWeight: 600, flex: 1, minWidth: 0 }}>
                                No payslip for {monthNames[payslipMonth]}.
                              </Typography>
                              {latestPayroll?.startDate && (
                                <Box
                                  component="span"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const d = new Date(latestPayroll.startDate);
                                    setPayslipMonth(d.getMonth());
                                    setPayslipYear(d.getFullYear());
                                  }}
                                  sx={{ fontSize: "0.58rem", fontWeight: 800, color: T.accent, whiteSpace: "nowrap", textDecoration: "underline", cursor: "pointer" }}
                                >
                                  View last
                                </Box>
                              )}
                            </Box>
                          )}
                        </Box>
                      </Box>
                    </SectionCard>

                    {/* Today */}
                    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
                      <EmployeeTodayCard
                        employeeNumber={employeeNumber}
                        leaveCredits={leaveCredits}
                      />
                    </Box>

                    {/* Mini Calendar */}
                    <SectionCard sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                      <PanelHeader
                        icon={CalendarMonth}
                        title={new Date(year, month).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                        right={
                          <Box sx={{ display: "flex", gap: 0.5 }}>
                            <IconButton size="small" onClick={() => setCalendarDate(new Date(year, month - 1, 1))} sx={{ color: T.accent, p: 0.3, borderRadius: "6px", "&:hover": { bgcolor: T.accentFaint } }}><ArrowBackIosNewIcon sx={{ fontSize: 13 }} /></IconButton>
                            <IconButton size="small" onClick={() => setCalendarDate(new Date(year, month + 1, 1))} sx={{ color: T.accent, p: 0.3, borderRadius: "6px", "&:hover": { bgcolor: T.accentFaint } }}><ArrowForwardIosIcon sx={{ fontSize: 13 }} /></IconButton>
                          </Box>
                        }
                      />
                      <Box sx={{ p: 1, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                        <Grid container spacing={0} sx={{ mb: 0.25 }}>
                          {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day) => (
                            <Grid item xs={12 / 7} key={day}>
                              <Typography sx={{ textAlign: "center", fontWeight: 700, fontSize: "0.48rem", color: T.accent, letterSpacing: "0.04em" }}>{day}</Typography>
                            </Grid>
                          ))}
                        </Grid>
                        <Grid container spacing={0.25} sx={{ flex: 1 }}>
                          {calendarDays.map((day, index) => {
                            const currentDateStr = buildDateStr(year, month, day);
                            const holidayData = day ? isDateInHolidayRange(currentDateStr) : null;
                            const dayNotes = day ? getNotesForDate(currentDateStr) : [];
                            const dayEvents = day ? getEventsForDate(currentDateStr) : [];
                            const dayAnnouncements = day ? getAnnouncementsForDate(currentDateStr) : [];
                            const hasNotesOrEvents = dayNotes.length > 0 || dayEvents.length > 0;
                            const hasAnnouncements = dayAnnouncements.length > 0;
                            const isToday = day === new Date().getDate() && month === new Date().getMonth() && year === new Date().getFullYear();
                            const tooltipTitle = isToday ? `Today${holidayData ? ` · ${holidayData.name}` : hasAnnouncements ? ` · ${dayAnnouncements[0].title}` : ""}` : holidayData ? `Holiday: ${holidayData.name}` : hasAnnouncements ? `${dayAnnouncements[0].title}` : "";
                            return (
                              <Grid item xs={12 / 7} key={index}>
                                <Tooltip title={tooltipTitle} arrow>
                                  <Box onClick={() => { if (day) { setSelectedDate(currentDateStr); setViewNotesDialog(true); } }}
                                    sx={{
                                      textAlign: "center", fontSize: "0.58rem",
                                      width: 18, height: 18, mx: "auto",
                                      borderRadius: "50%",
                                      display: "flex", alignItems: "center", justifyContent: "center",
                                      color: holidayData || isToday ? "#fff" : day ? T.text : "transparent",
                                      background: holidayData ? T.accent : isToday ? T.accent : hasAnnouncements ? "rgba(109,35,35,0.12)" : "transparent",
                                      fontWeight: holidayData || isToday || hasAnnouncements || hasNotesOrEvents ? 700 : 400,
                                      border: hasAnnouncements && !isToday && !holidayData ? `1.5px solid rgba(109,35,35,0.35)` : "none",
                                      cursor: day ? "pointer" : "default", transition: "all 0.15s", position: "relative",
                                      "&:hover": day ? { background: holidayData || isToday ? T.accentDark : T.accentFaint, transform: "scale(1.12)" } : {},
                                    }}>
                                    {day || ""}
                                    {hasNotesOrEvents && day && !isToday && !holidayData && (
                                      <Box sx={{ display: "flex", gap: 0.15, justifyContent: "center", position: "absolute", bottom: -1, left: 0, right: 0 }}>
                                        {dayNotes.length > 0 && <Box sx={{ width: 3, height: 3, borderRadius: "50%", bgcolor: "#ff9800" }} />}
                                        {dayEvents.length > 0 && <Box sx={{ width: 3, height: 3, borderRadius: "50%", bgcolor: "#4caf50" }} />}
                                      </Box>
                                    )}
                                  </Box>
                                </Tooltip>
                              </Grid>
                            );
                          })}
                        </Grid>
                        <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 0.2 }}>
                          <Tooltip title="Legends">
                            <IconButton size="small" onClick={(e) => setCalendarLegendAnchorEl(e.currentTarget)} sx={{ color: T.faint, p: 0.2, borderRadius: "4px", "&:hover": { bgcolor: T.accentFaint } }}><MoreVert sx={{ fontSize: 12 }} /></IconButton>
                          </Tooltip>
                        </Box>
                      </Box>
                    </SectionCard>
                </Box>

                {/* Bottom: DTR + Leave Requests + Leave Balances */}
                <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row", gap: 2, overflow: "visible" }}>

                  <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "visible" }}>
                    <DtrNoticePanel
                      employeeNumber={employeeNumber}
                      holidays={rawHolidays}
                    />
                  </Box>

                  <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "visible" }}>
                    <EmployeeHomeWidgets
                      embedded
                      hideToday
                      employeeNumber={employeeNumber}
                      leaveCredits={leaveCredits}
                      payrollData={payrollData}
                      payslipMonthName={monthNames[payslipMonth]}
                      unreadNotifCount={derivedUnreadCount}
                      holidays={rawHolidays}
                      suspensions={suspensions}
                    />
                  </Box>

                  <SectionCard sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", position: "relative" }}>
                    <PanelHeader icon={PieChartOutlineIcon} title="Leave Balances" />
                    <Box sx={{
                      flex: 1, minHeight: 0, overflowY: "auto", px: 1.25, py: 0.75, position: "relative",
                      "&::-webkit-scrollbar": { width: 4 },
                      "&::-webkit-scrollbar-track": { bgcolor: "rgba(0,0,0,0.04)", borderRadius: 3 },
                      "&::-webkit-scrollbar-thumb": { bgcolor: alpha(T.accent, 0.35), borderRadius: 3, "&:hover": { bgcolor: alpha(T.accent, 0.5) } },
                    }}>
                      {HIDE_LEAVE_CREDITS_DISPLAY ? (
                        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", height: "100%", py: 2 }}>
                          <Typography sx={{ fontWeight: 700, color: T.accent, fontSize: "0.75rem", mb: 0.5 }}>Leave Credit Summary</Typography>
                          <Typography sx={{ color: T.muted, fontSize: "0.65rem" }}>Details will be shown here.</Typography>
                        </Box>
                      ) : leaveLoading ? (
                        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, height: "100%", py: 2 }}>
                          <CircularProgress size={14} sx={{ color: T.accent }} />
                          <Typography sx={{ color: T.muted, fontSize: "0.72rem" }}>Loading...</Typography>
                        </Box>
                      ) : leaveCredits.length === 0 ? (
                        <Box sx={{
                          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                          height: "100%", textAlign: "center", px: 2, position: "relative", zIndex: 1,
                        }}>
                          <SpaIcon sx={{ fontSize: 48, color: "rgba(0,0,0,0.14)", mb: 1 }} />
                          <Typography sx={{ color: T.muted, fontSize: "0.72rem", fontWeight: 600 }}>No leave credits assigned.</Typography>
                          <SpaIcon sx={{
                            position: "absolute", right: -8, bottom: -12, fontSize: 96,
                            color: "rgba(109,35,35,0.04)", pointerEvents: "none", zIndex: 0,
                          }} />
                        </Box>
                      ) : (
                        <Box sx={{ display: "flex", flexDirection: "column" }}>
                          {leaveCredits.map((leave, idx) => (
                            <Box
                              key={idx}
                              sx={{
                                py: 0.9,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 1,
                                borderBottom: idx === leaveCredits.length - 1 ? "none" : `1px solid ${T.divider}`,
                                minWidth: 0,
                              }}
                            >
                              <Tooltip title={leave.name} arrow disableInteractive>
                                <Typography noWrap sx={{ fontSize: "0.72rem", fontWeight: 600, color: T.text }}>
                                  {leave.name}
                                </Typography>
                              </Tooltip>
                              <Box sx={{ textAlign: "right", flexShrink: 0 }}>
                                <Typography noWrap sx={{ fontSize: "0.95rem", fontWeight: 800, color: T.accent, lineHeight: 1.1 }}>
                                  {leave.currRemaining.toFixed(2)}
                                </Typography>
                                <Typography noWrap sx={{ fontSize: "0.52rem", color: T.faint, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                                  days left
                                </Typography>
                              </Box>
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  </SectionCard>
                </Box>
              </Box>
            </Grid>
          </Grid>

          {/* ── ANNOUNCEMENT DETAIL MODAL ── */}
          <Modal open={openModal} onClose={handleCloseModal}>
            <Fade in={openModal}>
              <Box sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: { xs: "96%", sm: "82%", md: "68%" }, maxWidth: 720, bgcolor: "background.paper", borderRadius: "16px", boxShadow: "0 32px 80px rgba(0,0,0,0.32)", maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", border: "0.5px solid rgba(0,0,0,0.09)" }}>
                {selectedAnnouncement && (() => {
                  const isHoliday = selectedAnnouncement.id?.toString().startsWith("holiday-");
                  const isSuspension = selectedAnnouncement.id?.toString().startsWith("suspension-");
                  const type = isHoliday ? "HOLIDAY" : isSuspension ? "SUSPENSION" : "ANNOUNCEMENT";
                  const accentColor = isHoliday ? "#FB8C00" : isSuspension ? "#B71C1C" : "#1976D2";
                  const fmtDate = (raw) => { if (!raw) return null; const d = new Date(raw); if (isNaN(d)) return null; return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }); };
                  const dateStart = fmtDate(selectedAnnouncement.date_start || selectedAnnouncement.date);
                  const dateEnd = fmtDate(selectedAnnouncement.date_end);
                  const dateRange = dateEnd && dateEnd !== dateStart ? `${dateStart} — ${dateEnd}` : dateStart;
                  const shortStart = selectedAnnouncement.date_start || selectedAnnouncement.date ? new Date(selectedAnnouncement.date_start || selectedAnnouncement.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
                  const shortEnd = selectedAnnouncement.date_end ? new Date(selectedAnnouncement.date_end).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
                  const dateChip = shortEnd && shortEnd !== shortStart ? `${shortStart} – ${shortEnd}` : shortStart;
                  return (
                    <>
                      <Box sx={{ position: "relative", height: { xs: 220, sm: 290, md: 330 }, flexShrink: 0, bgcolor: "#0d0d0d", overflow: "hidden" }}>
                        {selectedAnnouncement.image ? (
                          <Box component="img" src={`${API_BASE_URL}${selectedAnnouncement.image}`} alt={selectedAnnouncement.title} sx={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.42 }} />
                        ) : (
                          <Box sx={{ width: "100%", height: "100%", background: `linear-gradient(135deg, ${accentColor}dd 0%, #050505 100%)` }} />
                        )}
                        <Box sx={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.5) 48%, rgba(0,0,0,0.04) 100%)" }} />
                        <Box sx={{ position: "absolute", top: 0, left: 0, right: 0, px: 2.5, pt: 2, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, bgcolor: `${accentColor}55`, border: "0.5px solid rgba(255,255,255,0.2)", backdropFilter: "blur(10px)", borderRadius: "20px", px: 1.4, py: 0.5 }}>
                            <Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: accentColor }} />
                            <Typography sx={{ fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.12em", color: "#fff", textTransform: "uppercase" }}>{type}</Typography>
                          </Box>
                          <IconButton size="small" onClick={handleCloseModal} sx={{ bgcolor: "rgba(0,0,0,0.4)", color: "#fff", backdropFilter: "blur(8px)", border: "0.5px solid rgba(255,255,255,0.15)", width: 28, height: 28, "&:hover": { bgcolor: "rgba(0,0,0,0.65)", transform: "rotate(90deg)" }, transition: "all 0.2s" }}>
                            <CloseIcon sx={{ fontSize: 13 }} />
                          </IconButton>
                        </Box>
                        <Box sx={{ position: "absolute", bottom: 0, left: 0, right: 0, px: 3, pb: 2.5 }}>
                          {dateRange && <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1 }}><AccessTimeIcon sx={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }} /><Typography sx={{ fontSize: "0.72rem", color: "rgba(255,255,255,0.5)" }}>{dateRange}</Typography></Box>}
                          <Typography sx={{ color: "#fff", fontWeight: 800, fontSize: { xs: "1.2rem", sm: "1.5rem", md: "1.8rem" }, lineHeight: 1.2 }}>{selectedAnnouncement.title}</Typography>
                        </Box>
                      </Box>
                      <Box sx={{ height: "3px", flexShrink: 0, background: `linear-gradient(90deg, ${accentColor} 0%, transparent 100%)` }} />
                      <Box sx={{ px: 3, py: 1.25, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", borderBottom: `1px solid ${T.divider}`, flexShrink: 0 }}>
                        {dateChip && <Chip icon={<Event sx={{ fontSize: "12px !important", color: `${accentColor} !important` }} />} label={dateChip} size="small" sx={{ fontSize: "0.68rem", height: 22, fontWeight: 600, bgcolor: `${accentColor}0F`, border: `1px solid ${accentColor}28`, color: accentColor }} />}
                      </Box>
                      <Box sx={{ flex: 1, overflowY: "auto", px: 3, py: 2.25, "&::-webkit-scrollbar": { width: 3 }, "&::-webkit-scrollbar-thumb": { bgcolor: T.accentBorder, borderRadius: 2 } }}>
                        <Typography sx={{ fontSize: "0.9rem", color: T.text, lineHeight: 1.9, whiteSpace: "pre-line" }}>{selectedAnnouncement.about || "No additional details provided."}</Typography>
                      </Box>
                      <Box sx={{ px: 3, py: 1.5, borderTop: `1px solid ${T.divider}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, bgcolor: T.accentFaint, gap: 2 }}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
                          {[["#FB8C00", "Holiday"], ["#B71C1C", "Suspension"], ["#1976D2", "Announcement"]].map(([color, label]) => (
                            <Box key={label} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                              <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: color }} />
                              <Typography sx={{ fontSize: "0.68rem", color: T.muted }}>{label}</Typography>
                            </Box>
                          ))}
                        </Box>
                        <Button onClick={handleCloseModal} size="small" sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.78rem", color: "#fff", bgcolor: accentColor, borderRadius: "8px", px: 2.5, py: 0.65, "&:hover": { bgcolor: "transparent", color: accentColor, border: `1px solid ${accentColor}` } }}>Dismiss</Button>
                      </Box>
                    </>
                  );
                })()}
              </Box>
            </Fade>
          </Modal>

          {/* ── NOTIFICATIONS MODAL ── */}
          <Modal open={notifModalOpen} onClose={handleCloseNotifModal}>
            <Fade in={notifModalOpen}>
              <Box sx={{ position: "absolute", top: { xs: "50%", md: "76px" }, right: { xs: "50%", md: "20px" }, transform: { xs: "translate(50%, -50%)", md: "none" }, width: { xs: "92%", sm: "400px" }, height: { xs: "80vh", md: "min(85vh, 640px)" }, maxHeight: "85vh", display: "flex", flexDirection: "column", bgcolor: "#fff", border: `0.5px solid rgba(0,0,0,0.09)`, boxShadow: "0 16px 48px rgba(0,0,0,0.14)", borderRadius: "12px", overflow: "hidden" }}>
                <Box sx={{ px: 2, py: 1.25, background: T.accent, flexShrink: 0 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Box sx={{ width: 28, height: 28, borderRadius: "8px", bgcolor: "rgba(255,255,255,0.12)", border: "0.5px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <NotificationsIcon sx={{ fontSize: 14, color: "#fff" }} />
                    </Box>
                    <Typography sx={{ fontWeight: 700, fontSize: "0.88rem", color: "#fff", flexShrink: 0 }}>Notifications</Typography>
                    <Box sx={{ flex: 1 }} />
                    {derivedUnreadCount > 0 && (
                      <Box sx={{ px: 1, py: 0.15, borderRadius: "20px", bgcolor: "rgba(255,255,255,0.2)", border: "0.5px solid rgba(255,255,255,0.25)", color: "#fff", fontSize: "0.62rem", fontWeight: 700, lineHeight: 1.7, flexShrink: 0, whiteSpace: "nowrap" }}>{derivedUnreadCount} unread</Box>
                    )}
                    <NotifFilterChips activeFilter={notifFilter} onChange={setNotifFilter} unreadCount={derivedUnreadCount} />
                    <IconButton size="small" onClick={handleCloseNotifModal} sx={{ color: "rgba(255,255,255,0.8)", width: 24, height: 24, flexShrink: 0, bgcolor: "rgba(255,255,255,0.12)", border: "0.5px solid rgba(255,255,255,0.2)", borderRadius: "6px", "&:hover": { bgcolor: "rgba(255,255,255,0.22)" } }}>
                      <Close sx={{ fontSize: 12 }} />
                    </IconButton>
                  </Box>
                </Box>
                <Button fullWidth onClick={markAllNotificationsAsRead} disabled={derivedUnreadCount === 0}
                  sx={{ justifyContent: "flex-end", textTransform: "none", borderRadius: 0, py: 0.6, px: 2, fontSize: "0.68rem", fontWeight: 700, color: T.accent, bgcolor: T.accentFaint, borderBottom: `1px solid ${T.divider}`, "&:hover": { bgcolor: T.accentHover } }}>
                  Mark all as read
                </Button>
                <Box sx={{ flex: 1, minHeight: 280, overflowY: "auto", bgcolor: "#fff", "&::-webkit-scrollbar": { width: 3 }, "&::-webkit-scrollbar-thumb": { bgcolor: T.accentBorder, borderRadius: 2 } }}>
                  {Array.isArray(notifications) && notifications.length > 0 ? (
                    filteredNotifications.length > 0 ? (
                      filteredNotifications.slice(0, 50).map((notif, idx, arr) => {
                        const notifType = inferNotificationType(notif);
                        const isContact = notifType === "contact" || notifType === "ticket";
                        const isRead = notif.read_status === 1;
                        const TYPE_CONFIG = {
                          payslip:      { label: "Payroll",       accent: "#2e7d32", iconBg: "#e8f5e9" },
                          contact:      { label: "Ticket",        accent: "#c17f24", iconBg: "#fff8e1" },
                          ticket:       { label: "Ticket",        accent: "#c17f24", iconBg: "#fff8e1" },
                          holiday:      { label: "Holiday",       accent: "#1565c0", iconBg: "#e3f2fd" },
                          suspension:   { label: "Suspension",    accent: "#c62828", iconBg: "#ffebee" },
                          announcement: { label: "Announcement",  accent: T.accent,  iconBg: T.accentFaint },
                          leave:        { label: "Leave",         accent: "#2e7d32", iconBg: "#e8f5e9" },
                        };
                        const cfg = TYPE_CONFIG[notifType] || { label: "Notification", accent: T.accent, iconBg: T.accentFaint };
                        const ICON_MAP = {
                          payslip:      <Receipt sx={{ fontSize: 14, color: cfg.accent }} />,
                          contact:      <ContactPage sx={{ fontSize: 14, color: cfg.accent }} />,
                          ticket:       <ContactPage sx={{ fontSize: 14, color: cfg.accent }} />,
                          holiday:      <CalendarMonth sx={{ fontSize: 14, color: cfg.accent }} />,
                          suspension:   <Event sx={{ fontSize: 14, color: cfg.accent }} />,
                          announcement: <NotificationsIcon sx={{ fontSize: 14, color: cfg.accent }} />,
                          leave:        <Event sx={{ fontSize: 14, color: cfg.accent }} />,
                        };
                        const icon = ICON_MAP[notifType] || <NotificationsIcon sx={{ fontSize: 14, color: cfg.accent }} />;
                        const rawDesc = notif.description || "";
                        const cleanDesc = rawDesc.replace(/\. Click to view details\.?$/i, ".").replace(/\. Click to view response\.?$/i, ".").replace(/submitted a new ticket:\s*/i, "opened a ticket — ").replace(/has responded to your ticket\./i, "responded to your ticket.").replace(/replied to your ticket\./i, "replied to your ticket.").replace(/has been marked as replied by /i, "was marked as replied by ").replace(/has been resolved by /i, "was resolved by ").trim();
                        const timeAgo = (() => {
                          if (!notif.created_at) return "";
                          const diff = Date.now() - new Date(notif.created_at).getTime();
                          const m = Math.floor(diff / 60000);
                          if (m < 1) return "just now";
                          if (m < 60) return `${m}m ago`;
                          const h = Math.floor(m / 60);
                          if (h < 24) return `${h}h ago`;
                          const d = Math.floor(h / 24);
                          if (d < 7) return `${d}d ago`;
                          return new Date(notif.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
                        })();
                        const dayLabel = getNotificationDayLabel(notif.created_at);
                        const prevDayLabel = idx > 0 ? getNotificationDayLabel(arr[idx - 1]?.created_at) : null;
                        const showDayLabel = idx === 0 || dayLabel !== prevDayLabel;
                        const isImageType = notifType === "announcement" || notifType === "holiday" || notifType === "suspension";
                        const isAnnouncementCard = notifType === "announcement";
                        const carouselItem = isImageType ? getCarouselItemForNotif(notif) : null;
                        const itemImage = carouselItem?.image ? `${API_BASE_URL}${carouselItem.image}` : null;
                        const itemTitle = carouselItem?.title || notif.title || "";
                        const itemAbout = carouselItem?.about || "";
                        const ticketEntry = isContact ? (contactTicketStatuses || {})[notif.id] : null;
                        const ticketSubject = ticketEntry?.subject || "";
                        const ticketEmpName = ticketEntry?.employee_name || "";
                        const ticketEmpNum = ticketEntry?.employee_number || notif.employeeNumber || "";

                        if (isImageType) {
                          return (
                            <React.Fragment key={`notif-wrap-${notif.id || idx}`}>
                              {showDayLabel && <Box sx={{ px: 2, pt: idx === 0 ? 0.9 : 1.2, pb: 0.45, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.faint, bgcolor: T.accentFaint, borderBottom: `1px solid ${T.divider}` }}>{dayLabel}</Box>}
                              <Box onClick={() => handleNotificationClick(notif)} sx={{ borderBottom: `1px solid ${T.divider}`, bgcolor: isRead ? "#fff" : T.accentFaint, cursor: "pointer", transition: "background 0.12s", "&:hover": { bgcolor: isRead ? "#fdf8f8" : T.accentHover }, borderLeft: isRead ? "none" : `3px solid ${T.accent}` }}>
                                {isAnnouncementCard ? (
                                  <Box sx={{ position: "relative", height: 90, overflow: "hidden", mx: 1.5, mt: 1.25, borderRadius: "8px" }}>
                                    {itemImage ? <Box component="img" src={itemImage} alt={itemTitle} sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <Box sx={{ width: "100%", height: "100%", background: `linear-gradient(135deg,${T.accent},${T.accentDark})` }} />}
                                    <Box sx={{ position: "absolute", inset: 0, background: "linear-gradient(to top,rgba(0,0,0,0.82) 0%,transparent 60%)" }} />
                                    <Box sx={{ position: "absolute", top: 7, left: 8, px: 1, py: 0.15, borderRadius: "12px", bgcolor: T.accent }}>
                                      <Typography sx={{ fontSize: "0.55rem", fontWeight: 700, color: "#fff", letterSpacing: "0.08em", textTransform: "uppercase" }}>{cfg.label}</Typography>
                                    </Box>
                                    {!isRead && <Box sx={{ position: "absolute", top: 7, right: 8, width: 7, height: 7, borderRadius: "50%", bgcolor: "#fff", outline: `2px solid ${T.accent}` }} />}
                                    {itemTitle && <Typography sx={{ position: "absolute", bottom: 7, left: 10, right: 10, fontSize: "0.72rem", fontWeight: 600, color: "#fff", lineHeight: 1.3 }}>{itemTitle}</Typography>}
                                  </Box>
                                ) : (
                                  <Box sx={{ mx: 1.5, mt: 1.1, borderRadius: "8px", overflow: "hidden", height: 60, display: "flex", alignItems: "center", px: 1.5, gap: 1.25, border: `1px solid ${cfg.accent}30`, bgcolor: `${cfg.accent}0A` }}>
                                    <Box sx={{ width: 32, height: 32, borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", bgcolor: `${cfg.accent}15` }}>{icon}</Box>
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                      <Typography sx={{ fontSize: "0.55rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", mb: 0.2, color: cfg.accent }}>{cfg.label}</Typography>
                                      <Typography sx={{ fontSize: "0.74rem", fontWeight: 600, color: T.text, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{itemTitle || cleanDesc}</Typography>
                                    </Box>
                                    {!isRead && <Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: T.accent, flexShrink: 0 }} />}
                                  </Box>
                                )}
                                <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.5, py: 1, pb: 1.25 }}>
                                  <Typography sx={{ flex: 1, fontSize: "0.73rem", color: T.muted, lineHeight: 1.45 }}>{cleanDesc || itemAbout}</Typography>
                                  <Typography sx={{ fontSize: "0.62rem", color: T.faint, flexShrink: 0, mt: 0.1 }}>{timeAgo}</Typography>
                                </Box>
                              </Box>
                            </React.Fragment>
                          );
                        }

                        return (
                          <React.Fragment key={`notif-wrap-${notif.id || idx}`}>
                            {showDayLabel && <Box sx={{ px: 2, pt: idx === 0 ? 0.9 : 1.2, pb: 0.45, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.faint, bgcolor: T.accentFaint, borderBottom: `1px solid ${T.divider}` }}>{dayLabel}</Box>}
                            <Box onClick={() => handleNotificationClick(notif)} sx={{ display: "flex", alignItems: "flex-start", gap: 1.25, pl: isRead ? 2.25 : 2, pr: 2.25, py: 1.5, borderBottom: `1px solid ${T.divider}`, borderLeft: isRead ? "none" : `3px solid ${T.accent}`, bgcolor: isRead ? "#fff" : T.accentFaint, cursor: "pointer", transition: "background 0.12s", "&:hover": { bgcolor: isRead ? "#fdf8f8" : T.accentHover } }}>
                              <Box sx={{ width: 36, height: 36, borderRadius: "8px", bgcolor: cfg.iconBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, mt: 0.15 }}>{icon}</Box>
                              <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 0.3 }}>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
                                    <Typography sx={{ fontSize: "0.6rem", fontWeight: 700, color: cfg.accent, textTransform: "uppercase", letterSpacing: "0.07em" }}>{cfg.label}</Typography>
                                    {isContact && <TicketStatusBadge notifId={notif.id} contactTicketStatuses={contactTicketStatuses} />}
                                  </Box>
                                  <Typography sx={{ fontSize: "0.62rem", color: T.faint, flexShrink: 0, ml: 1 }}>{timeAgo}</Typography>
                                </Box>
                                {isContact && ticketSubject ? (
                                  <>
                                    <Typography sx={{ fontSize: "0.8rem", color: T.text, fontWeight: isRead ? 500 : 700, lineHeight: 1.45, mb: 0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ticketSubject}</Typography>
                                    <Typography sx={{ fontSize: "0.75rem", color: T.muted, lineHeight: 1.4, mb: 0.3 }}>{cleanDesc}</Typography>
                                    {(ticketEmpName || ticketEmpNum) && (
                                      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.4, flexWrap: "wrap" }}>
                                        {ticketEmpName && <Box sx={{ display: "flex", alignItems: "center", gap: 0.4 }}><Box sx={{ width: 5, height: 5, borderRadius: "50%", bgcolor: cfg.accent }} /><Typography sx={{ fontSize: "0.68rem", color: T.muted, fontWeight: 500 }}>{ticketEmpName}</Typography></Box>}
                                        {ticketEmpNum && <Typography sx={{ fontSize: "0.65rem", color: T.faint, fontFamily: "monospace" }}>#{ticketEmpNum}</Typography>}
                                      </Box>
                                    )}
                                  </>
                                ) : (
                                  <Typography sx={{ fontSize: "0.8rem", color: T.text, fontWeight: isRead ? 400 : 600, lineHeight: 1.55 }}>{cleanDesc}</Typography>
                                )}
                              </Box>
                              {!isRead && <Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: T.accent, flexShrink: 0, mt: 0.5 }} />}
                            </Box>
                          </React.Fragment>
                        );
                      })
                    ) : (
                      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 7, px: 3 }}>
                        <Box sx={{ width: 48, height: 48, borderRadius: "50%", bgcolor: T.accentFaint, display: "flex", alignItems: "center", justifyContent: "center", mb: 1.5 }}><NotificationsIcon sx={{ fontSize: 22, color: T.accentBorder }} /></Box>
                        <Typography sx={{ fontWeight: 700, fontSize: "0.85rem", color: T.text, mb: 0.4 }}>No results</Typography>
                        <Typography sx={{ fontSize: "0.72rem", color: T.faint, textAlign: "center" }}>No notifications match this filter.</Typography>
                      </Box>
                    )
                  ) : (
                    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 8, px: 3 }}>
                      <Box sx={{ width: 52, height: 52, borderRadius: "50%", bgcolor: T.accentFaint, display: "flex", alignItems: "center", justifyContent: "center", mb: 1.5 }}><NotificationsIcon sx={{ fontSize: 26, color: T.accentBorder }} /></Box>
                      <Typography sx={{ fontWeight: 700, fontSize: "0.88rem", color: T.text, mb: 0.4 }}>All caught up</Typography>
                      <Typography sx={{ fontSize: "0.75rem", color: T.faint, textAlign: "center" }}>No new notifications at this time.</Typography>
                    </Box>
                  )}
                </Box>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 1.5, py: 1, bgcolor: T.accentFaint, borderTop: `1px solid ${T.divider}`, flexWrap: "wrap" }}>
                  <Typography sx={{ fontSize: "0.6rem", fontWeight: 700, color: T.faint, letterSpacing: "0.08em", textTransform: "uppercase" }}>Legend:</Typography>
                  {[{ label: "Holiday", bg: "rgba(237,108,2,0.2)", border: "#ed6c02" }, { label: "Suspension", bg: "rgba(211,47,47,0.15)", border: "#d32f2f" }, { label: "On Leave", bg: "rgba(46,125,50,0.15)", border: "#2e7d32" }].map((item) => (
                    <Box key={item.label} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                      <Box sx={{ width: 10, height: 10, borderRadius: "3px", bgcolor: item.bg, border: `1.5px solid ${item.border}` }} />
                      <Typography sx={{ fontSize: "0.64rem", color: T.muted }}>{item.label}</Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Fade>
          </Modal>

          {/* ── CALENDAR LEGENDS MENU ── */}
          <Menu anchorEl={calendarLegendAnchorEl} open={openCalendarLegend} onClose={() => setCalendarLegendAnchorEl(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}
            PaperProps={{ sx: { borderRadius: 2, minWidth: 180, bgcolor: "#fff", border: `1px solid ${T.accentBorder}`, boxShadow: "0 12px 32px rgba(0,0,0,0.12)" } }}>
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography sx={{ fontWeight: 700, color: T.accent, mb: 1, fontSize: "0.8rem" }}>Legends</Typography>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
                {[["#ff9800", "Notes"], ["#4caf50", "Events"], [T.accent, "Holidays"], [T.accentMid, "Today"]].map(([color, label]) => (
                  <Box key={label} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: color }} />
                    <Typography sx={{ color: T.text, fontSize: "0.75rem" }}>{label}</Typography>
                  </Box>
                ))}
              </Box>
            </Box>
          </Menu>

          {/* ── VIEW NOTES/EVENTS DIALOG ── */}
          <Dialog open={viewNotesDialog} onClose={() => setViewNotesDialog(false)} maxWidth="sm" fullWidth BackdropProps={{ sx: { backgroundColor: "rgba(0,0,0,0.52)", backdropFilter: "blur(4px)" } }}
            PaperProps={{ sx: { borderRadius: "12px", border: `0.5px solid rgba(0,0,0,0.09)`, boxShadow: "0 28px 64px rgba(0,0,0,0.18)" } }}>
            <Box sx={{ px: 2.5, py: 1.5, background: T.accent, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Typography sx={{ fontWeight: 700, fontSize: "0.9rem", color: "#fff" }}>
                {selectedDate && (() => { const [y, m, d] = selectedDate.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); })()}
              </Typography>
              <IconButton size="small" onClick={() => setViewNotesDialog(false)} sx={{ color: "rgba(255,255,255,0.85)", p: 0.5, "&:hover": { bgcolor: "rgba(255,255,255,0.15)" }, borderRadius: "6px" }}><CloseIcon sx={{ fontSize: 15 }} /></IconButton>
            </Box>
            <DialogContent sx={{ pt: 2 }}>
              <Typography sx={{ fontWeight: 700, color: T.accent, mb: 1, fontSize: "0.8rem", display: "flex", alignItems: "center", gap: 0.5 }}><Note sx={{ fontSize: 15 }} /> Notes</Typography>
              {getNotesForDate(selectedDate).length > 0 ? getNotesForDate(selectedDate).map((note) => (
                <Box key={note.id} sx={{ mb: 1.5, p: 1.5, bgcolor: T.accentFaint, borderRadius: "8px", border: `1px solid ${T.accentBorder}` }}>
                  <Typography sx={{ fontSize: "0.82rem", color: T.text }}>{note.content}</Typography>
                  <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 0.75 }}>
                    <IconButton size="small" onClick={() => handleDeleteNote(note.id)} sx={{ color: T.faint, p: 0.25, borderRadius: "4px", "&:hover": { bgcolor: "#FCEBEB", color: T.accent } }}><Delete sx={{ fontSize: 13 }} /></IconButton>
                  </Box>
                </Box>
              )) : <Typography sx={{ color: T.faint, mb: 2, fontSize: "0.75rem" }}>No notes for this date</Typography>}
              <Typography sx={{ fontWeight: 700, color: T.accent, mb: 1, mt: 2, fontSize: "0.8rem", display: "flex", alignItems: "center", gap: 0.5 }}><Event sx={{ fontSize: 15 }} /> Events</Typography>
              {getEventsForDate(selectedDate).length > 0 ? getEventsForDate(selectedDate).map((event) => (
                <Box key={event.id} sx={{ mb: 1.5, p: 1.5, bgcolor: "rgba(76,175,80,0.06)", borderRadius: "8px", border: "1px solid rgba(76,175,80,0.2)" }}>
                  <Typography sx={{ fontWeight: 600, fontSize: "0.82rem", color: T.text }}>{event.title}</Typography>
                  <Typography sx={{ fontSize: "0.75rem", color: T.muted }}>{event.description}</Typography>
                  <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 0.75 }}>
                    <IconButton size="small" onClick={() => handleDeleteEvent(event.id)} sx={{ color: T.faint, p: 0.25, borderRadius: "4px", "&:hover": { bgcolor: "#FCEBEB", color: T.accent } }}><Delete sx={{ fontSize: 13 }} /></IconButton>
                  </Box>
                </Box>
              )) : <Typography sx={{ color: T.faint, mb: 2, fontSize: "0.75rem" }}>No events for this date</Typography>}
              <Typography sx={{ fontWeight: 700, color: T.accent, mb: 1, mt: 2, fontSize: "0.8rem", display: "flex", alignItems: "center", gap: 0.5 }}><Flag sx={{ fontSize: 15 }} /> Announcements</Typography>
              {(() => {
                const dateAnnouncements = announcements.filter((a) => normalizeDate(a.date) === selectedDate);
                return dateAnnouncements.length > 0 ? dateAnnouncements.map((announcement) => (
                  <Box key={announcement.id} onClick={() => { setViewNotesDialog(false); handleOpenModal(announcement); }}
                    sx={{ mb: 1.5, p: 1.5, bgcolor: "#e3f2fd", borderRadius: "8px", border: "1px solid #bbdefb", cursor: "pointer", transition: "all 0.15s", "&:hover": { bgcolor: "#bbdefb", transform: "translateY(-1px)" } }}>
                    <Typography sx={{ fontWeight: 600, fontSize: "0.82rem" }}>{announcement.title}</Typography>
                    <Typography sx={{ fontSize: "0.72rem", mt: 0.25 }}>{announcement.about && announcement.about.length > 100 ? `${announcement.about.substring(0, 100)}...` : announcement.about}</Typography>
                  </Box>
                )) : <Typography sx={{ color: T.faint, fontSize: "0.75rem" }}>No announcements for this date</Typography>;
              })()}
            </DialogContent>
            <Box sx={{ px: 2.5, py: 1.5, borderTop: `1px solid ${T.divider}`, display: "flex", justifyContent: "flex-end", gap: 1 }}>
              <Button onClick={() => { setViewNotesDialog(false); handleAddNote(); }} size="small" startIcon={<Note sx={{ fontSize: 14 }} />} sx={{ borderRadius: 2, textTransform: "none", fontWeight: 700, fontSize: "0.78rem", color: "#fff", bgcolor: T.accent, px: 2, "&:hover": { bgcolor: T.accentDark } }}>Add Note</Button>
              <Button onClick={() => { setViewNotesDialog(false); handleAddEvent(); }} size="small" startIcon={<Add sx={{ fontSize: 14 }} />} sx={{ borderRadius: 2, textTransform: "none", fontWeight: 700, fontSize: "0.78rem", color: "#fff", bgcolor: T.accent, px: 2, "&:hover": { bgcolor: T.accentDark } }}>Add Event</Button>
              <Button onClick={() => setViewNotesDialog(false)} size="small" sx={{ borderRadius: 2, textTransform: "none", fontWeight: 600, fontSize: "0.78rem", color: T.muted, border: `1px solid ${T.divider}`, "&:hover": { bgcolor: T.accentFaint } }}>Close</Button>
            </Box>
          </Dialog>

          {/* ── ADD NOTE DIALOG ── */}
          <Dialog open={openNoteDialog} onClose={() => setOpenNoteDialog(false)} maxWidth="sm" fullWidth BackdropProps={{ sx: { backgroundColor: "rgba(0,0,0,0.52)", backdropFilter: "blur(4px)" } }}
            PaperProps={{ sx: { borderRadius: "12px", border: `0.5px solid rgba(0,0,0,0.09)`, boxShadow: "0 28px 64px rgba(0,0,0,0.18)", overflow: "hidden" } }}>
            <Box sx={{ px: 2.5, py: 1.5, background: T.accent, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Note sx={{ fontSize: 16, color: "#fff" }} />
                <Typography sx={{ fontWeight: 700, fontSize: "0.9rem", color: "#fff" }}>Add Note</Typography>
              </Box>
              <IconButton size="small" onClick={() => setOpenNoteDialog(false)} sx={{ color: "rgba(255,255,255,0.85)", p: 0.5, "&:hover": { bgcolor: "rgba(255,255,255,0.15)" }, borderRadius: "6px" }}><CloseIcon sx={{ fontSize: 15 }} /></IconButton>
            </Box>
            <Box sx={{ px: 2.5, pt: 2.25, pb: 0.5 }}>
              <TextField autoFocus fullWidth multiline rows={4} label="Note Content" value={currentNote.content} onChange={(e) => setCurrentNote({ ...currentNote, content: e.target.value })} sx={{ mb: 1.5, "& .MuiOutlinedInput-root": { borderRadius: 2 } }} />
              <Typography sx={{ fontSize: "0.7rem", color: T.faint }}>Date: {currentNote.date && (() => { const [y, m, d] = currentNote.date.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(); })()}</Typography>
            </Box>
            <Box sx={{ px: 2.5, py: 1.75, display: "flex", justifyContent: "flex-end", gap: 1 }}>
              <Button onClick={() => setOpenNoteDialog(false)} size="small" sx={{ borderRadius: 2, textTransform: "none", fontWeight: 600, fontSize: "0.8rem", color: T.muted, border: `1px solid ${T.divider}`, "&:hover": { bgcolor: T.accentFaint }, px: 2 }}>Cancel</Button>
              <Button onClick={handleSaveNote} variant="contained" size="small" disabled={!currentNote.content} startIcon={<Save sx={{ fontSize: 14 }} />} sx={{ borderRadius: 2, fontWeight: 700, textTransform: "none", bgcolor: T.accent, color: "#fff", px: 2.5, "&:hover": { bgcolor: T.accentDark } }}>Save Note</Button>
            </Box>
          </Dialog>

          {/* ── ADD EVENT DIALOG ── */}
          <Dialog open={openEventDialog} onClose={() => setOpenEventDialog(false)} maxWidth="sm" fullWidth BackdropProps={{ sx: { backgroundColor: "rgba(0,0,0,0.52)", backdropFilter: "blur(4px)" } }}
            PaperProps={{ sx: { borderRadius: "12px", border: `0.5px solid rgba(0,0,0,0.09)`, boxShadow: "0 28px 64px rgba(0,0,0,0.18)", overflow: "hidden" } }}>
            <Box sx={{ px: 2.5, py: 1.5, background: T.accent, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Event sx={{ fontSize: 16, color: "#fff" }} />
                <Typography sx={{ fontWeight: 700, fontSize: "0.9rem", color: "#fff" }}>Add Event</Typography>
              </Box>
              <IconButton size="small" onClick={() => setOpenEventDialog(false)} sx={{ color: "rgba(255,255,255,0.85)", p: 0.5, "&:hover": { bgcolor: "rgba(255,255,255,0.15)" }, borderRadius: "6px" }}><CloseIcon sx={{ fontSize: 15 }} /></IconButton>
            </Box>
            <Box sx={{ px: 2.5, pt: 2.25, pb: 0.5 }}>
              <TextField autoFocus fullWidth label="Event Title" value={currentEvent.title} onChange={(e) => setCurrentEvent({ ...currentEvent, title: e.target.value })} sx={{ mb: 1.5, "& .MuiOutlinedInput-root": { borderRadius: 2 } }} />
              <TextField fullWidth label="Event Date" type="date" variant="outlined" size="small" value={currentEvent.date} onChange={(e) => setCurrentEvent({ ...currentEvent, date: e.target.value })} InputLabelProps={{ shrink: true }} sx={{ mb: 1.5, "& .MuiOutlinedInput-root": { borderRadius: 2 } }} />
              <TextField fullWidth multiline rows={3} label="Event Description" value={currentEvent.description} onChange={(e) => setCurrentEvent({ ...currentEvent, description: e.target.value })} sx={{ mb: 0.5, "& .MuiOutlinedInput-root": { borderRadius: 2 } }} />
            </Box>
            <Box sx={{ px: 2.5, py: 1.75, display: "flex", justifyContent: "flex-end", gap: 1 }}>
              <Button onClick={() => setOpenEventDialog(false)} size="small" sx={{ borderRadius: 2, textTransform: "none", fontWeight: 600, fontSize: "0.8rem", color: T.muted, border: `1px solid ${T.divider}`, "&:hover": { bgcolor: T.accentFaint }, px: 2 }}>Cancel</Button>
              <Button onClick={handleSaveEvent} variant="contained" size="small" disabled={!currentEvent.title} startIcon={<Save sx={{ fontSize: 14 }} />} sx={{ borderRadius: 2, fontWeight: 700, textTransform: "none", bgcolor: T.accent, color: "#fff", px: 2.5, "&:hover": { bgcolor: T.accentDark } }}>Save Event</Button>
            </Box>
          </Dialog>

        </Box>
      </Box>
    </Fade>
  );
};

export default Home;
