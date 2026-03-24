import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { disconnectPrismaClient, prisma } from '../prisma/prismaClient';
import {
  buildEncryptedMerchantSecretUpdate,
  buildMerchantSecretBackupEntry,
  MERCHANT_SECRET_FIELDS,
  type MerchantSecretBackupEntry,
  type MerchantSecretRecord,
} from '../security/merchant-secret-migration';

type MigrationMode = 'dry-run' | 'apply' | 'verify' | 'rollback';

type ScriptArgs = {
  mode: MigrationMode;
  backupFile: string | null;
};

type BackupFilePayload = {
  version: 1;
  createdAt: string;
  merchants: MerchantSecretBackupEntry[];
};

function parseArgs(argv: string[]): ScriptArgs {
  const backupFileArg = argv.find((arg) => arg.startsWith('--backup-file='));
  const rollbackFileArg = argv.find((arg) =>
    arg.startsWith('--rollback-file='),
  );

  if (rollbackFileArg) {
    return {
      mode: 'rollback',
      backupFile: rollbackFileArg.slice('--rollback-file='.length).trim() || null,
    };
  }

  if (argv.includes('--verify')) {
    return { mode: 'verify', backupFile: null };
  }

  if (argv.includes('--apply')) {
    return {
      mode: 'apply',
      backupFile: backupFileArg?.slice('--backup-file='.length).trim() || null,
    };
  }

  return { mode: 'dry-run', backupFile: null };
}

function merchantSecretSelect() {
  return Object.fromEntries(
    MERCHANT_SECRET_FIELDS.map((field) => [field, true]),
  ) as Record<(typeof MERCHANT_SECRET_FIELDS)[number], true>;
}

type MerchantSecretPrismaClient = typeof prisma;

async function loadMerchantSecrets(prismaClient: MerchantSecretPrismaClient) {
  return prismaClient.merchant.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      ...merchantSecretSelect(),
    },
  }) as Promise<MerchantSecretRecord[]>;
}

function summarize(entries: MerchantSecretBackupEntry[]) {
  const fieldCounts = Object.fromEntries(
    MERCHANT_SECRET_FIELDS.map((field) => [field, 0]),
  ) as Record<(typeof MERCHANT_SECRET_FIELDS)[number], number>;

  for (const entry of entries) {
    for (const field of Object.keys(entry.fields) as (typeof MERCHANT_SECRET_FIELDS)[number][]) {
      fieldCounts[field] += 1;
    }
  }

  return {
    merchantsAffected: entries.length,
    fieldCounts,
  };
}

async function writeBackupFile(
  backupFile: string,
  merchants: MerchantSecretBackupEntry[],
) {
  const resolvedPath = resolve(backupFile);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const payload: BackupFilePayload = {
    version: 1,
    createdAt: new Date().toISOString(),
    merchants,
  };
  await writeFile(resolvedPath, JSON.stringify(payload, null, 2), 'utf8');
  return resolvedPath;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  try {
    if (args.mode === 'rollback') {
      if (!args.backupFile) {
        throw new Error('--rollback-file=<path> is required');
      }

      const rollbackPath = resolve(args.backupFile);
      const raw = await readFile(rollbackPath, 'utf8');
      const backup = JSON.parse(raw) as BackupFilePayload;
      if (!Array.isArray(backup.merchants)) {
        throw new Error('Rollback file is invalid');
      }

      for (const merchant of backup.merchants) {
        await prisma.merchant.update({
          where: { id: merchant.merchantId },
          data: merchant.fields,
        });
      }

      console.log(
        JSON.stringify({
          mode: 'rollback',
          restoredMerchants: backup.merchants.length,
          rollbackFile: rollbackPath,
        }),
      );
      return;
    }

    const merchants = await loadMerchantSecrets(prisma);
    const backupEntries = merchants
      .map((merchant) => buildMerchantSecretBackupEntry(merchant))
      .filter((entry): entry is MerchantSecretBackupEntry => Boolean(entry));
    const summary = summarize(backupEntries);

    if (args.mode === 'dry-run') {
      console.log(
        JSON.stringify({
          mode: 'dry-run',
          ...summary,
          merchants: backupEntries,
        }),
      );
      return;
    }

    if (args.mode === 'verify') {
      if (backupEntries.length > 0) {
        console.error(
          JSON.stringify({
            mode: 'verify',
            ok: false,
            ...summary,
            merchants: backupEntries,
          }),
        );
        process.exitCode = 1;
        return;
      }

      console.log(
        JSON.stringify({
          mode: 'verify',
          ok: true,
          merchantsAffected: 0,
          fieldCounts: Object.fromEntries(
            MERCHANT_SECRET_FIELDS.map((field) => [field, 0]),
          ),
        }),
      );
      return;
    }

    if (!args.backupFile) {
      throw new Error(
        '--backup-file=<path> is required when applying the merchant secret migration',
      );
    }

    const backupPath = await writeBackupFile(args.backupFile, backupEntries);
    let updatedMerchants = 0;

    for (const merchant of merchants) {
      const update = buildEncryptedMerchantSecretUpdate(merchant);
      if (!update) continue;

      await prisma.merchant.update({
        where: { id: update.merchantId },
        data: update.data,
      });
      updatedMerchants += 1;
    }

    const remaining = (await loadMerchantSecrets(prisma))
      .map((merchant) => buildMerchantSecretBackupEntry(merchant))
      .filter((entry): entry is MerchantSecretBackupEntry => Boolean(entry));

    if (remaining.length > 0) {
      console.error(
        JSON.stringify({
          mode: 'apply',
          ok: false,
          updatedMerchants,
          backupFile: backupPath,
          remaining,
        }),
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify({
        mode: 'apply',
        ok: true,
        updatedMerchants,
        backupFile: backupPath,
        ...summary,
      }),
    );
  } finally {
    await disconnectPrismaClient();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      mode: 'error',
      message,
    }),
  );
  process.exit(1);
});
