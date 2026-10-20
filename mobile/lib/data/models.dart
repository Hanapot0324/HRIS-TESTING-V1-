/// Plain data models for the staff self-service screens. Parsing is lenient
/// (MySQL values may arrive as strings or numbers) but never invents values:
/// missing numbers stay null and are shown as "—".
library;

double? _num(dynamic v) {
  if (v == null) return null;
  if (v is num) return v.toDouble();
  return double.tryParse(v.toString().replaceAll(',', ''));
}

String? _str(dynamic v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

DateTime? _date(dynamic v) {
  final s = _str(v);
  return s == null ? null : DateTime.tryParse(s);
}

class Profile {
  const Profile({
    required this.employeeNumber,
    this.firstName,
    this.middleName,
    this.lastName,
    this.nameExtension,
    this.email,
    this.mobileNumber,
    this.employmentType,
    this.department,
  });

  final String employeeNumber;
  final String? firstName;
  final String? middleName;
  final String? lastName;
  final String? nameExtension;
  final String? email;
  final String? mobileNumber;
  final String? employmentType;
  final String? department;

  String get fullName => [
    firstName,
    middleName,
    lastName,
    nameExtension,
  ].whereType<String>().where((s) => s.isNotEmpty).join(' ');

  factory Profile.fromJson(Map<String, dynamic> j) => Profile(
    employeeNumber: j['employeeNumber'].toString(),
    firstName: _str(j['firstName']),
    middleName: _str(j['middleName']),
    lastName: _str(j['lastName']),
    nameExtension: _str(j['nameExtension']),
    email: _str(j['email']),
    mobileNumber: _str(j['mobileNum']),
    employmentType: _str(j['employmentType']),
    department: _str(j['department']),
  );
}

class DtrRecord {
  const DtrRecord({
    required this.date,
    this.day,
    this.timeIn,
    this.breakIn,
    this.breakOut,
    this.timeOut,
    this.remarks,
    this.officialIn,
    this.officialOut,
  });

  final DateTime date;
  final String? day;
  final String? timeIn;
  final String? breakIn;
  final String? breakOut;
  final String? timeOut;
  final String? remarks;
  final String? officialIn;
  final String? officialOut;

  factory DtrRecord.fromJson(Map<String, dynamic> j) => DtrRecord(
    date: DateTime.parse(j['date'] as String),
    day: _str(j['day']),
    timeIn: _str(j['timeIN']),
    breakIn: _str(j['breaktimeIN']),
    breakOut: _str(j['breaktimeOUT']),
    timeOut: _str(j['timeOUT']),
    remarks: _str(j['remarks']),
    officialIn: _str(j['officialTimeIN']),
    officialOut: _str(j['officialTimeOUT']),
  );
}

class LeaveType {
  const LeaveType({required this.code, required this.description});

  final String code;
  final String description;

  factory LeaveType.fromJson(Map<String, dynamic> j) => LeaveType(
    code: j['leave_code'].toString(),
    description: _str(j['leave_description']) ?? j['leave_code'].toString(),
  );
}

/// A leave credit allocation. Hours are shown exactly as the server computes
/// them — the app does not convert hours to days (hours/day varies by schedule).
class LeaveBalance {
  const LeaveBalance({
    required this.leaveCode,
    this.description,
    this.totalHours,
    this.usedHours,
    this.remainingHours,
    this.periodYear,
    this.periodSemester,
  });

  final String leaveCode;
  final String? description;
  final double? totalHours;
  final double? usedHours;
  final double? remainingHours;
  final String? periodYear;
  final String? periodSemester;

  static LeaveBalance? fromJson(Map<String, dynamic> j) {
    if (j['voided_at'] != null) return null; // voided allocations don't count
    return LeaveBalance(
      leaveCode: j['leave_code'].toString(),
      description: _str(j['leave_description']),
      totalHours: _num(j['total_hours']),
      usedHours: _num(j['used_hours']),
      remainingHours: _num(j['remaining_hours']),
      periodYear: _str(j['period_year']),
      periodSemester: _str(j['period_semester']),
    );
  }
}

/// Status codes used by the existing leave workflow (leave_request.status).
enum LeaveStatus {
  pending(0, 'Pending'),
  supervisorApproved(1, 'Supervisor approved'),
  hrApproved(2, 'HR approved'),
  denied(3, 'Denied'),
  cancelled(4, 'Cancelled'),
  unknown(-1, 'Unknown');

  const LeaveStatus(this.code, this.label);
  final int code;
  final String label;

  static LeaveStatus fromCode(dynamic v) {
    final n = int.tryParse(v?.toString() ?? '');
    return LeaveStatus.values.firstWhere(
      (s) => s.code == n,
      orElse: () => LeaveStatus.unknown,
    );
  }
}

class LeaveRequest {
  const LeaveRequest({
    required this.id,
    required this.leaveCode,
    required this.leaveDate,
    required this.status,
    this.description,
    this.createdAt,
    this.denialReason,
  });

  final int id;
  final String leaveCode;
  final String? description;
  final DateTime? leaveDate;
  final LeaveStatus status;
  final DateTime? createdAt;
  final String? denialReason;

  /// Mirrors the server rule: staff may only withdraw a pending request.
  bool get canCancel => status == LeaveStatus.pending;

  factory LeaveRequest.fromJson(Map<String, dynamic> j) => LeaveRequest(
    id: int.parse(j['id'].toString()),
    leaveCode: j['leave_code'].toString(),
    description: _str(j['leave_description']),
    leaveDate: _date(j['leave_date']),
    status: LeaveStatus.fromCode(j['status']),
    createdAt: _date(j['created_at']),
    denialReason: _str(j['denial_reason']),
  );
}

/// Service Credit or CTO balance line, in hours.
class CreditBalance {
  const CreditBalance({
    required this.label,
    this.earnedHours,
    this.usedHours,
    this.remainingHours,
    this.expiryDate,
  });

  final String label;
  final double? earnedHours;
  final double? usedHours;
  final double? remainingHours;
  final DateTime? expiryDate;

  factory CreditBalance.fromJson(Map<String, dynamic> j, String label) =>
      CreditBalance(
        label: label,
        earnedHours: _num(j['earned_hours']),
        usedHours: _num(j['used_hours']),
        remainingHours: _num(j['remaining_hours']),
        expiryDate: _date(j['expiry_date']),
      );
}

class AppNotification {
  const AppNotification({
    required this.id,
    required this.description,
    required this.read,
    this.createdAt,
  });

  final int id;
  final String description;
  final bool read;
  final DateTime? createdAt;

  AppNotification copyWith({bool? read}) => AppNotification(
    id: id,
    description: description,
    read: read ?? this.read,
    createdAt: createdAt,
  );

  factory AppNotification.fromJson(Map<String, dynamic> j) => AppNotification(
    id: int.parse(j['id'].toString()),
    description: _str(j['description']) ?? '',
    read: j['read_status'].toString() == '1',
    createdAt: _date(j['created_at']),
  );
}

class Announcement {
  const Announcement({
    required this.id,
    required this.title,
    this.about,
    this.dateStart,
    this.dateEnd,
  });

  final int id;
  final String title;
  final String? about;
  final DateTime? dateStart;
  final DateTime? dateEnd;

  factory Announcement.fromJson(Map<String, dynamic> j) => Announcement(
    id: int.parse(j['id'].toString()),
    title: _str(j['title']) ?? 'Announcement',
    about: _str(j['about']),
    dateStart: _date(j['date_start']),
    dateEnd: _date(j['date_end']),
  );
}
