import 'package:intl/intl.dart';

import '../api/api_client.dart';
import 'models.dart';

/// All staff self-service calls the app makes. Every one is either an
/// /api/me route (identity from the token only) or an existing route the
/// backend guards with requireSelfOrAdmin / caller scoping. The employee
/// number in a path is a routing convenience, not proof of ownership — the
/// server checks it against the token.
class HrisRepository {
  HrisRepository(this._api, this.employeeNumber);

  final ApiClient _api;
  final String employeeNumber;

  static final _ymd = DateFormat('yyyy-MM-dd');

  String get _emp => Uri.encodeComponent(employeeNumber);

  List<Map<String, dynamic>> _list(dynamic data) =>
      (data is List ? data : const [])
          .whereType<Map<String, dynamic>>()
          .toList();

  Future<Profile> profile() async => Profile.fromJson(
    await _api.get('/api/me/profile') as Map<String, dynamic>,
  );

  Future<List<DtrRecord>> dtr(DateTime from, DateTime to) async {
    final data = await _api.get(
      '/api/me/dtr',
      query: {'from': _ymd.format(from), 'to': _ymd.format(to)},
    );
    return _list((data as Map<String, dynamic>)['records'])
        .map(DtrRecord.fromJson)
        .toList();
  }

  Future<List<LeaveType>> leaveTypes() async =>
      _list(await _api.get('/api/me/leave-types'))
          .map(LeaveType.fromJson)
          .toList();

  Future<List<LeaveBalance>> leaveBalances() async =>
      _list(await _api.get('/leaveRoute/leave_assignment/employee/$_emp'))
          .map(LeaveBalance.fromJson)
          .whereType<LeaveBalance>()
          .toList();

  Future<List<LeaveRequest>> leaveRequests() async =>
      _list(await _api.get('/leaveRoute/leave_request/$_emp'))
          .map(LeaveRequest.fromJson)
          .toList();

  /// Files a request through the existing workflow. The server forces the
  /// owner to the signed-in employee and the status to "submitted".
  Future<void> submitLeave(String leaveCode, List<DateTime> dates) =>
      _api.post('/leaveRoute/leave_request', {
        'employeeNumber': employeeNumber,
        'leave_code': leaveCode,
        'leave_dates': dates.map(_ymd.format).toList(),
      });

  /// Withdraws one of the caller's own pending requests (status 4).
  Future<void> cancelLeave(int requestId) =>
      _api.put('/leaveRoute/leave_request/$requestId', {'status': 4});

  Future<List<CreditBalance>> serviceCredits() async {
    final data = await _api.get(
      '/api/earnings/sc/$_emp/balance',
    ) as Map<String, dynamic>;
    return _list(data['balances'])
        .map(
          (j) => CreditBalance.fromJson(
            j,
            'Service Credits (${_scTypeLabel(j['sc_type'])})',
          ),
        )
        .toList();
  }

  Future<List<CreditBalance>> cto() async {
    final data = await _api.get(
      '/api/earnings/cto/$_emp/balance',
    ) as Map<String, dynamic>;
    return _list(data['balances'])
        .map((j) => CreditBalance.fromJson(j, 'Compensatory Time Off'))
        .toList();
  }

  Future<List<AppNotification>> notifications() async =>
      _list(await _api.get('/api/notifications/$_emp'))
          .map(AppNotification.fromJson)
          .toList();

  Future<void> markNotificationRead(int id) =>
      _api.put('/api/notifications/$id/read', null);

  Future<void> markAllNotificationsRead() =>
      _api.put('/api/notifications/$_emp/read-all', null);

  /// Employee audience only — never request the HR-only feed.
  Future<List<Announcement>> announcements() async => _list(
    await _api.get(
      '/api/announcements',
      query: {'audience': 'employee'},
      authenticated: false,
    ),
  ).map(Announcement.fromJson).toList();

  static String _scTypeLabel(dynamic t) {
    final s = (t ?? '').toString().replaceAll('_', ' ').trim();
    if (s.isEmpty) return 'general';
    return s;
  }
}
