import 'dart:convert';

import 'package:earist_hris_staff/api/api_client.dart';
import 'package:earist_hris_staff/data/hris_repository.dart';
import 'package:earist_hris_staff/data/models.dart';
import 'package:earist_hris_staff/ui/screens/dtr_screen.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

void main() {
  late FakeBackend backend;
  late HrisRepository repo;

  setUp(() {
    backend = FakeBackend();
    final api = ApiClient(
      baseUri: Uri.parse('https://hris.example.test'),
      httpClient: backend.client,
    )..token = 'tok';
    repo = HrisRepository(api, '1001');
  });

  test(
    'DTR uses /api/me/dtr with dates only — no employee identifier',
    () async {
      backend.routes['/api/me/dtr'] =
          (_) => backend.json({
            'records': [
              {
                'date': '2026-10-01',
                'day': 'Thursday',
                'timeIN': '07:58 AM',
                'timeOUT': '05:01 PM',
              },
            ],
          });
      final rows = await repo.dtr(
        DateTime(2026, 10, 1),
        DateTime(2026, 10, 15),
      );
      final q = backend.requests.single.url.queryParameters;
      expect(q, {'from': '2026-10-01', 'to': '2026-10-15'});
      expect(rows.single.timeIn, '07:58 AM');
      expect(rows.single.breakIn, isNull);
    },
  );

  test('announcements request the employee audience only', () async {
    backend.routes['/api/announcements'] = (_) => backend.json([]);
    await repo.announcements();
    expect(backend.requests.single.url.queryParameters, {
      'audience': 'employee',
    });
  });

  test('voided leave allocations are not shown as balances', () async {
    backend.routes['/leaveRoute/leave_assignment/employee/1001'] =
        (_) => backend.json([
          {'leave_code': 'VL', 'remaining_hours': '40', 'voided_at': null},
          {
            'leave_code': 'SL',
            'remaining_hours': 16,
            'voided_at': '2026-01-01',
          },
        ]);
    final list = await repo.leaveBalances();
    expect(list.map((b) => b.leaveCode), ['VL']);
    expect(list.single.remainingHours, 40);
  });

  test('cancel sends only status 4 for the given request', () async {
    backend.routes['/leaveRoute/leave_request/55'] =
        (_) => backend.json({'ok': true});
    await repo.cancelLeave(55);
    final r = backend.requests.single;
    expect(r.method, 'PUT');
    expect(jsonDecode(r.body), {'status': 4});
  });

  test('submit sends type + dates and never a status', () async {
    backend.routes['/leaveRoute/leave_request'] =
        (_) => backend.json({'ok': true});
    await repo.submitLeave('VL', [
      DateTime(2026, 11, 3),
      DateTime(2026, 11, 4),
    ]);
    final body =
        jsonDecode(backend.requests.single.body) as Map<String, dynamic>;
    expect(body, {
      'employeeNumber': '1001',
      'leave_code': 'VL',
      'leave_dates': ['2026-11-03', '2026-11-04'],
    });
  });

  test('employee number in a path is URL-encoded', () async {
    final api = ApiClient(
      baseUri: Uri.parse('https://hris.example.test'),
      httpClient: backend.client,
    )..token = 'tok';
    backend.routes['/api/notifications/A%2F1'] = (_) => backend.json([]);
    await HrisRepository(api, 'A/1').notifications();
    expect(backend.requests.single.url.path, '/api/notifications/A%2F1');
  });

  group('models', () {
    test('only pending requests can be cancelled', () {
      for (final s in LeaveStatus.values) {
        final r = LeaveRequest(
          id: 1,
          leaveCode: 'VL',
          leaveDate: null,
          status: s,
        );
        expect(r.canCancel, s == LeaveStatus.pending, reason: s.name);
      }
    });

    test('unknown status codes are not treated as pending', () {
      expect(LeaveStatus.fromCode('9'), LeaveStatus.unknown);
      expect(LeaveStatus.fromCode(null), LeaveStatus.unknown);
    });

    test('DTR periods', () {
      final feb = DateTime(2028, 2);
      expect(dtrRange(feb, DtrHalf.first).end, DateTime(2028, 2, 15));
      expect(dtrRange(feb, DtrHalf.second).start, DateTime(2028, 2, 16));
      expect(dtrRange(feb, DtrHalf.second).end, DateTime(2028, 2, 29));
      expect(dtrRange(feb, DtrHalf.whole).start, DateTime(2028, 2, 1));
    });
  });
}
