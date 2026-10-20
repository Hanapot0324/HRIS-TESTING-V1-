import 'package:flutter/material.dart';

import '../../auth/auth_controller.dart';
import '../../data/hris_repository.dart';
import '../../data/models.dart';
import '../theme.dart';
import '../widgets/async_body.dart';

/// Read-only profile. Corrections go through HR (spec §3.3) — staff cannot
/// edit authoritative HR records from the app.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.auth, required this.repo});

  final AuthController auth;
  final HrisRepository repo;

  Future<void> _confirmSignOut(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (ok == true) await auth.signOut();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: AsyncBody<Profile>(
        load: repo.profile,
        builder: (context, p, _) {
          final theme = Theme.of(context);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        p.fullName.isEmpty ? '—' : p.fullName,
                        style: theme.textTheme.titleLarge,
                      ),
                      const SizedBox(height: 12),
                      InfoRow('Employee no.', p.employeeNumber),
                      InfoRow('Department', orDash(p.department)),
                      InfoRow('Employment type', orDash(p.employmentType)),
                      InfoRow('Email', orDash(p.email)),
                      InfoRow('Mobile', orDash(p.mobileNumber)),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Something wrong? Ask the HR office to correct your record. '
                'Changes are verified by HR before they take effect.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 24),
              Text('Help & support', style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              const Card(
                child: Column(
                  children: [
                    ListTile(
                      leading: Icon(Icons.support_agent_outlined),
                      title: Text('HR office'),
                      subtitle: Text(
                        'For account, attendance, leave or payroll questions, '
                        'contact the EARIST HR office.',
                      ),
                    ),
                    ListTile(
                      leading: Icon(Icons.shield_outlined),
                      title: Text('Keep your account safe'),
                      subtitle: Text(
                        'Never share your password or verification code — '
                        'not even with HR or IT staff.',
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
              OutlinedButton.icon(
                onPressed: () => _confirmSignOut(context),
                icon: const Icon(Icons.logout),
                label: const Text('Sign out'),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
