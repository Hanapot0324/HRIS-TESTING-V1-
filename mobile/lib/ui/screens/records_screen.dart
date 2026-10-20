import 'package:flutter/material.dart';

import '../../data/hris_repository.dart';
import '../../data/models.dart';
import '../theme.dart';
import '../widgets/async_body.dart';

/// Service Credit and CTO balances (view only). Credits are earned, adjusted
/// and voided by HR; nothing here can change them.
class RecordsScreen extends StatelessWidget {
  const RecordsScreen({super.key, required this.repo});

  final HrisRepository repo;

  Future<List<CreditBalance>> _load() async {
    final results = await Future.wait([repo.serviceCredits(), repo.cto()]);
    return [...results[0], ...results[1]];
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My Records')),
      body: AsyncBody<List<CreditBalance>>(
        load: _load,
        isEmpty: (l) => l.isEmpty,
        emptyMessage: 'No Service Credit or CTO records.',
        builder: (context, list, _) {
          final theme = Theme.of(context);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text('Service Credits & CTO', style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                'Shown in hours. Earnings and adjustments are recorded by HR.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              for (final c in list) ...[
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(c.label, style: theme.textTheme.titleSmall),
                        const SizedBox(height: 8),
                        InfoRow('Remaining', fmtHours(c.remainingHours)),
                        InfoRow('Used', fmtHours(c.usedHours)),
                        InfoRow('Earned', fmtHours(c.earnedHours)),
                        if (c.expiryDate != null)
                          InfoRow('Expires', fmtDate.format(c.expiryDate!)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 8),
              ],
              const SizedBox(height: 8),
              Text('Payslips', style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                'Payslips are available on the HRIS web portal. Mobile access is '
                'pending approval.',
                style: theme.textTheme.bodySmall,
              ),
            ],
          );
        },
      ),
    );
  }
}
