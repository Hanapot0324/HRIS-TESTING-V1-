import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../auth/auth_controller.dart';
import '../widgets/async_body.dart';

class OtpScreen extends StatefulWidget {
  const OtpScreen({super.key, required this.auth});

  final AuthController auth;

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  static const _resendSeconds = 60;
  final _code = TextEditingController();
  String? _error;
  int _cooldown = _resendSeconds;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _startCooldown();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _code.dispose();
    super.dispose();
  }

  void _startCooldown() {
    _timer?.cancel();
    setState(() => _cooldown = _resendSeconds);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      setState(() => _cooldown--);
      if (_cooldown <= 0) t.cancel();
    });
  }

  Future<void> _verify() async {
    if (_code.text.length != 6) {
      setState(() => _error = 'Enter the 6-digit code.');
      return;
    }
    final err = await widget.auth.verifyCode(_code.text);
    if (!mounted) return;
    setState(() => _error = err);
    if (err != null) _code.clear();
  }

  Future<void> _resend() async {
    final err = await widget.auth.resendCode();
    if (!mounted) return;
    if (err == null) {
      _startCooldown();
      showSnack(context, 'A new code was sent to your email.');
    }
    setState(() => _error = err);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Verify sign-in'),
        leading: BackButton(onPressed: widget.auth.cancelOtp),
      ),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: widget.auth,
          builder: (context, _) {
            final busy = widget.auth.busy;
            final email = widget.auth.maskedEmail;
            return ListView(
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  email == null || email.isEmpty
                      ? 'Enter the verification code sent to your email.'
                      : 'Enter the verification code sent to $email.',
                  style: theme.textTheme.bodyLarge,
                ),
                const SizedBox(height: 24),
                TextField(
                  controller: _code,
                  enabled: !busy,
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  autofillHints: const [AutofillHints.oneTimeCode],
                  maxLength: 6,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    letterSpacing: 8,
                  ),
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: const InputDecoration(
                    labelText: 'Verification code',
                    counterText: '',
                  ),
                  onSubmitted: (_) => _verify(),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: busy ? null : _verify,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                  ),
                  child: const Text('Verify'),
                ),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: busy || _cooldown > 0 ? null : _resend,
                  child: Text(
                    _cooldown > 0
                        ? 'Resend code in ${_cooldown}s'
                        : 'Resend code',
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  'Never share this code. HR staff will never ask for it.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodySmall,
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
