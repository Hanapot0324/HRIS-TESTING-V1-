import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'auth/auth_controller.dart';
import 'auth/session.dart';
import 'config.dart';
import 'data/hris_repository.dart';
import 'ui/screens/home_shell.dart';
import 'ui/screens/login_screen.dart';
import 'ui/screens/otp_screen.dart';
import 'ui/theme.dart';
import 'ui/widgets/async_body.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final Uri baseUri;
  try {
    baseUri = AppConfig.baseUri();
  } on StateError catch (e) {
    runApp(_ConfigErrorApp(e.message));
    return;
  }
  final api = ApiClient(baseUri: baseUri);
  final auth = AuthController(api: api, store: SecureSessionStore())..restore();
  runApp(HrisApp(auth: auth, api: api));
}

class HrisApp extends StatelessWidget {
  const HrisApp({super.key, required this.auth, required this.api});

  final AuthController auth;
  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'EARIST HRIS',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: ListenableBuilder(
        listenable: auth,
        builder: (context, _) {
          final session = auth.session;
          return switch (auth.stage) {
            AuthStage.restoring => const Scaffold(
              body: Center(child: CircularProgressIndicator()),
            ),
            AuthStage.signedOut => LoginScreen(
              key: const ValueKey('login'),
              auth: auth,
            ),
            AuthStage.otp => OtpScreen(auth: auth),
            AuthStage.signedIn => HomeShell(
              // New employee -> fresh shell, no cached data from a previous user.
              key: ValueKey(session!.employeeNumber),
              auth: auth,
              repo: HrisRepository(api, session.employeeNumber),
            ),
          };
        },
      ),
    );
  }
}

class _ConfigErrorApp extends StatelessWidget {
  const _ConfigErrorApp(this.message);

  final String message;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildTheme(Brightness.light),
    home: Scaffold(
      body: Center(
        child: StatusMessage(
          icon: Icons.settings_outlined,
          title: 'App not configured',
          message: message,
        ),
      ),
    ),
  );
}
