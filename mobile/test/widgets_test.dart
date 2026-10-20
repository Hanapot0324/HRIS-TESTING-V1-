import 'package:earist_hris_staff/api/api_client.dart';
import 'package:earist_hris_staff/auth/auth_controller.dart';
import 'package:earist_hris_staff/auth/session.dart';
import 'package:earist_hris_staff/data/hris_repository.dart';
import 'package:earist_hris_staff/main.dart';
import 'package:earist_hris_staff/ui/screens/dtr_screen.dart';
import 'package:earist_hris_staff/ui/screens/leave_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

void main() {
  late FakeBackend backend;
  late ApiClient api;
  late AuthController auth;

  setUp(() {
    backend = FakeBackend(mfaRequired: false);
    api = ApiClient(
      baseUri: Uri.parse('https://hris.example.test'),
      httpClient: backend.client,
    );
    auth = AuthController(api: api, store: MemorySessionStore());
    backend.routes.addAll({
      '/leaveRoute/leave_assignment/employee/1001': (_) => backend.json([]),
      '/leaveRoute/leave_request/1001':
          (_) => backend.json([
            {
              'id': 1,
              'leave_code': 'VL',
              'leave_description': 'Vacation Leave',
              'leave_date': '2026-11-03',
              'status': 0,
            },
            {
              'id': 2,
              'leave_code': 'SL',
              'leave_description': 'Sick Leave',
              'leave_date': '2026-10-01',
              'status': 2,
            },
          ]),
      '/api/announcements': (_) => backend.json([]),
      '/api/notifications/1001': (_) => backend.json([]),
    });
  });

  testWidgets('sign-in failure shows the error; success opens staff home', (
    tester,
  ) async {
    await auth.restore();
    await tester.pumpWidget(HrisApp(auth: auth, api: api));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Employee number'),
      '1001',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'wrong',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();
    expect(find.text('Invalid credentials'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'Correct#Pass1',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();
    expect(find.text('Hello, Ana'), findsOneWidget);
  });

  testWidgets('employee number field drops hyphens and upper-cases', (
    tester,
  ) async {
    await auth.restore();
    await tester.pumpWidget(HrisApp(auth: auth, api: api));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Employee number'),
      'ab-12',
    );
    expect(find.text('AB12'), findsOneWidget);
  });

  testWidgets('staff navigation has only self-service destinations', (
    tester,
  ) async {
    await auth.signIn('1001', 'Correct#Pass1');
    await tester.pumpWidget(HrisApp(auth: auth, api: api));
    await tester.pumpAndSettle();
    final labels =
        tester
            .widgetList<NavigationDestination>(
              find.byType(NavigationDestination),
            )
            .map((d) => d.label)
            .toList();
    expect(labels, ['Home', 'My DTR', 'My Leave', 'My Records', 'Profile']);
    for (final word in [
      'Payroll',
      'Approve',
      'Users',
      'Admin',
      'Reports',
      'Settings',
    ]) {
      expect(find.textContaining(word), findsNothing, reason: word);
    }
  });

  testWidgets('leave list offers Cancel only on pending requests', (
    tester,
  ) async {
    api.token = 'tok';
    await tester.pumpWidget(
      MaterialApp(home: LeaveScreen(repo: HrisRepository(api, '1001'))),
    );
    await tester.pumpAndSettle();
    expect(find.text('Vacation Leave'), findsOneWidget);
    expect(find.text('Sick Leave'), findsOneWidget);
    expect(find.text('Cancel request'), findsOneWidget);
    expect(find.text('HR approved'), findsOneWidget);
  });

  testWidgets('DTR loads the current half-month, then the selected period', (
    tester,
  ) async {
    api.token = 'tok';
    backend.routes['/api/me/dtr'] = (_) => backend.json({'records': []});
    await tester.pumpWidget(
      MaterialApp(
        home: DtrScreen(
          repo: HrisRepository(api, '1001'),
          now: () => DateTime(2026, 10, 20),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(backend.requests.last.url.queryParameters, {
      'from': '2026-10-16',
      'to': '2026-10-31',
    });
    expect(find.text('No attendance records for this period.'), findsOneWidget);

    await tester.tap(find.text('Whole month'));
    await tester.pumpAndSettle();
    expect(backend.requests.last.url.queryParameters, {
      'from': '2026-10-01',
      'to': '2026-10-31',
    });

    await tester.tap(find.byTooltip('Previous month'));
    await tester.pumpAndSettle();
    expect(backend.requests.last.url.queryParameters, {
      'from': '2026-09-01',
      'to': '2026-09-30',
    });
  });

  testWidgets('access denied is shown as such, not as a crash or sign-out', (
    tester,
  ) async {
    api.token = 'tok';
    backend.routes['/api/me/dtr'] =
        (_) => backend.json({'error': 'Access denied'}, 403);
    await tester.pumpWidget(
      MaterialApp(
        home: DtrScreen(
          repo: HrisRepository(api, '1001'),
          now: () => DateTime(2026, 10, 5),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Access denied'), findsWidgets);
    expect(api.hasToken, isTrue);
  });
}
