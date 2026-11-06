#!/usr/bin/env python3
"""Builds the Corvane demo workspace: a fictional fintech with six small git repos and four policies.

    python3 scripts/make-demo-workspace.py <dir>

<dir> must not exist (or be empty). It gets:
  policies/        security.md, privacy.md, payments.md, ai-agents.md (planted contradictions: EU-only data and 30-day
                   deletion vs transcripts kept 90 days by a US partner)
  api/ payments/ agents/ web/ infra/ gateway/   each its own git repo; `main` keeps every promise
Branches (the planted breaks):
  agent/refund-autopilot  in agents, payments and infra: a coding agent removes refund approval, logs the card
                          number and CVC, and adds a bucket in us-east-1
  feature/statement-export in api: a teammate adds a controller without TenantGuard
Each repo also gets a bare remote in <dir>.remotes/ so `git push` can run (and be blocked by the pre-push hook).

Corvane is fictional. The core files are small and real; the rest of each repo is generated from one template per
repo, so the workspace looks like a real product without much code. Authors and dates are fixed.
"""
import os
import subprocess
import sys
import textwrap

ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Corvane Engineering", "GIT_AUTHOR_EMAIL": "eng@corvane.example",
    "GIT_COMMITTER_NAME": "Corvane Engineering", "GIT_COMMITTER_EMAIL": "eng@corvane.example",
    "GIT_AUTHOR_DATE": "2026-10-28T10:00:00+01:00", "GIT_COMMITTER_DATE": "2026-10-28T10:00:00+01:00",
}
GIT_FLAGS = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false",
             "-c", "core.excludesFile=/dev/null", "-c", "init.defaultBranch=main"]


def git(repo, *args, author=None):
    env = dict(ENV)
    if author:
        env["GIT_AUTHOR_NAME"], env["GIT_AUTHOR_EMAIL"] = author
    subprocess.run(["git", "-C", repo, *GIT_FLAGS, *args], check=True, env=env, stdout=subprocess.DEVNULL)


def write(root, path, text):
    full = os.path.join(root, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(textwrap.dedent(text).lstrip("\n"))


def pascal(name):
    return "".join(p.capitalize() for p in name.replace("_", "-").split("-"))


# ── Policies ───────────────────────────────────────────────────────────────────────────────────────────────────────
POLICIES = {
    "security.md": """
        # Corvane Security

        How we protect the accounts, payments and data of the businesses that use Corvane.

        ## Transport and edge
        - All traffic to Corvane is encrypted with TLS 1.2 or higher.
        - Our API gateway sends a Strict-Transport-Security header on every response.
        - Every customer has its own rate limit at the gateway, so one customer cannot slow down another.

        ## Access
        - Every API endpoint requires a signed-in session and is scoped to the caller's own company: one customer can never read another customer's data.
        - Every database query for customer records is filtered by the customer's tenant id.
        - Passwords are hashed with bcrypt at cost factor 12 or higher.
        - Sessions expire after 30 minutes without activity, and administrators must use multi-factor authentication.
        - Every change to customer data is written to an audit log with who made it.

        ## Infrastructure
        - Storage buckets are encrypted with our own KMS keys and are never public.
        - Databases are encrypted at rest and keep 35 days of backups.
        - Logs are kept for one year.
        - Secrets never appear in logs: our logger removes passwords, tokens and authorization headers.

        ## Incidents
        - If a breach affects your data, we tell you within 72 hours.
    """,
    "privacy.md": """
        # Corvane Privacy Notice

        ## Where your data lives
        - Customer data, including support transcripts from our AI assistant, is stored and processed only in the European Union: Frankfurt, with disaster recovery in Ireland.

        ## How we use it
        - We never sell personal data.
        - Personal data such as names, emails and IBANs is removed from prompts before they reach an AI model.
        - Support transcripts are deleted after 30 days.
        - Our web app never sends email addresses or names to analytics.
        - Session tokens live only in secure, httpOnly cookies, never in browser storage.
        - Our logs never contain email addresses or bank account numbers.

        ## Your choices
        - You can export or delete your company's data at any time from Settings.
    """,
    "payments.md": """
        # Corvane Payments Standard

        - Card numbers are tokenized by our vault the moment they arrive. Corvane systems never store or log a full card number or a CVC.
        - Every payment request carries an idempotency key, so a retry can never charge a customer twice.
        - Money amounts are whole numbers in minor units (cents), never floating point.
        - Webhooks from our payment processor are accepted only after their signature is verified, and events older than 5 minutes are rejected.
        - Every refund records the person who approved it.
        - Payouts above EUR 10,000 need two different approvers.
    """,
    "ai-agents.md": """
        # Rules for AI agents at Corvane

        These rules apply to Penny, our AI support agent, and to the AI coding agents that change our code.

        ## Penny, the support agent
        - Penny can only use the tools on her allow list.
        - Every refund Penny issues needs approval from a person on the support team before money moves.
        - Every tool has a risk level, and Penny's tools never return a full card number: only the last four digits.
        - Model output is never run as code: Penny cannot execute shell commands or SQL that a model wrote.
        - To improve answer quality, support transcripts are kept for 90 days by our evaluation partner in the United States.

        ## Coding agents
        - Coding agents must not remove signature checks, tenant guards or approval steps.
        - Coding agents never create infrastructure outside our EU regions (eu-central-1 and eu-west-1).
    """,
}

# ── api (TypeScript, NestJS) ───────────────────────────────────────────────────────────────────────────────────────
API_MODULES = ["accounts", "customers", "invoices", "statements", "transfers", "payouts", "cards", "disputes",
               "beneficiaries", "mandates", "reports", "team", "roles", "webhook-endpoints", "api-keys", "settings",
               "exports", "notifications", "tax-ids", "budgets", "approvals", "documents"]


def api_repo(root):
    write(root, "package.json", """
        {
          "name": "@corvane/api",
          "private": true,
          "scripts": { "start": "nest start", "build": "nest build", "test": "jest" },
          "dependencies": { "@nestjs/common": "^11.1.0", "@nestjs/core": "^11.1.0", "bcrypt": "^6.0.0", "typeorm": "^0.3.27" }
        }
    """)
    write(root, "src/main.ts", """
        import { NestFactory } from '@nestjs/core';
        import helmet from 'helmet';
        import { AppModule } from './app.module';
        import { ALLOWED_ORIGINS } from './config';

        async function bootstrap() {
          const app = await NestFactory.create(AppModule, { bufferLogs: true });
          app.use(helmet());
          app.enableCors({ origin: ALLOWED_ORIGINS, credentials: true });
          await app.listen(process.env.PORT ?? 3000);
        }
        void bootstrap();
    """)
    write(root, "src/config.ts", """
        export const ALLOWED_ORIGINS = ['https://app.corvane.example'];
        export const DATA_REGION = 'eu-central-1';
    """)
    write(root, "src/common/guards/auth.guard.ts", """
        import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
        import { SessionService } from '../../auth/session.service';

        @Injectable()
        export class AuthGuard implements CanActivate {
          constructor(private readonly sessions: SessionService) {}

          async canActivate(ctx: ExecutionContext): Promise<boolean> {
            const req = ctx.switchToHttp().getRequest();
            const session = await this.sessions.resume(req.cookies?.corvane_session);
            if (!session) throw new UnauthorizedException();
            req.user = session.user;
            return true;
          }
        }
    """)
    write(root, "src/common/guards/tenant.guard.ts", """
        import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

        /** Binds the request to the signed-in user's company. Services read req.tenant.id, never a client value. */
        @Injectable()
        export class TenantGuard implements CanActivate {
          canActivate(ctx: ExecutionContext): boolean {
            const req = ctx.switchToHttp().getRequest();
            if (!req.user?.tenantId) throw new ForbiddenException('No company on this session');
            req.tenant = { id: req.user.tenantId };
            return true;
          }
        }
    """)
    write(root, "src/common/logger.ts", """
        import pino from 'pino';

        /** Fields removed from every log line. */
        export const REDACT = ['password', 'token', 'authorization', 'cookie', 'email', 'iban', 'apiKey'];

        export const logger = pino({ redact: { paths: REDACT.flatMap((k) => [k, `*.${k}`]), censor: '[removed]' } });
    """)
    write(root, "src/common/request.ts", """
        export interface TenantRequest {
          user: { id: string; tenantId: string; role: 'member' | 'admin'; mfa: boolean };
          tenant: { id: string };
        }
    """)
    write(root, "src/auth/session.service.ts", """
        import { Injectable, UnauthorizedException } from '@nestjs/common';
        import * as bcrypt from 'bcrypt';
        import { SessionStore } from './session.store';

        export const BCRYPT_ROUNDS = 12;
        export const SESSION_IDLE_MINUTES = 30;

        @Injectable()
        export class SessionService {
          constructor(private readonly store: SessionStore) {}

          hashPassword(password: string): Promise<string> {
            return bcrypt.hash(password, BCRYPT_ROUNDS);
          }

          async signIn(user: { id: string; role: string; passwordHash: string; mfaVerified: boolean }, password: string) {
            if (!(await bcrypt.compare(password, user.passwordHash))) throw new UnauthorizedException();
            if (user.role === 'admin' && !user.mfaVerified) throw new UnauthorizedException('MFA required for administrators');
            return this.store.create(user.id, { idleMinutes: SESSION_IDLE_MINUTES });
          }

          resume(id: string | undefined) {
            return id ? this.store.touch(id, { idleMinutes: SESSION_IDLE_MINUTES }) : null;
          }
        }
    """)
    write(root, "src/auth/session.store.ts", """
        import { Injectable } from '@nestjs/common';
        import { Redis } from 'ioredis';

        @Injectable()
        export class SessionStore {
          constructor(private readonly redis: Redis) {}
          async create(userId: string, opts: { idleMinutes: number }) {
            const id = crypto.randomUUID();
            await this.redis.set(`session:${id}`, userId, 'EX', opts.idleMinutes * 60);
            return { id };
          }
          async touch(id: string, opts: { idleMinutes: number }) {
            const userId = await this.redis.getex(`session:${id}`, 'EX', opts.idleMinutes * 60);
            return userId ? { user: await this.loadUser(userId) } : null;
          }
          private async loadUser(id: string) { return { id, tenantId: '', role: 'member' as const, mfa: false }; }
        }
    """)
    write(root, "src/audit/audit.service.ts", """
        import { Injectable } from '@nestjs/common';
        import { Repository } from 'typeorm';
        import { AuditEvent } from './audit-event.entity';
        import type { TenantRequest } from '../common/request';

        @Injectable()
        export class AuditService {
          constructor(private readonly events: Repository<AuditEvent>) {}

          record(req: TenantRequest, action: string, subjectId: string) {
            return this.events.insert({ tenantId: req.tenant.id, actorId: req.user.id, action, subjectId, at: new Date() });
          }
        }
    """)
    write(root, "src/audit/audit-event.entity.ts", """
        import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

        @Entity('audit_events')
        export class AuditEvent {
          @PrimaryGeneratedColumn('uuid') id!: string;
          @Column() tenantId!: string;
          @Column() actorId!: string;
          @Column() action!: string;
          @Column() subjectId!: string;
          @Column() at!: Date;
        }
    """)
    write(root, "src/privacy/data-rights.controller.ts", """
        import { Controller, Delete, Get, Req, UseGuards } from '@nestjs/common';
        import { AuthGuard } from '../common/guards/auth.guard';
        import { TenantGuard } from '../common/guards/tenant.guard';
        import { AuditService } from '../audit/audit.service';
        import { DataRightsService } from './data-rights.service';
        import type { TenantRequest } from '../common/request';

        @UseGuards(AuthGuard, TenantGuard)
        @Controller('settings/data')
        export class DataRightsController {
          constructor(private readonly rights: DataRightsService, private readonly audit: AuditService) {}

          @Get('export')
          async export(@Req() req: TenantRequest) {
            await this.audit.record(req, 'data.exported', req.tenant.id);
            return this.rights.exportAll(req.tenant.id);
          }

          @Delete()
          async erase(@Req() req: TenantRequest) {
            await this.audit.record(req, 'data.erasure_requested', req.tenant.id);
            return this.rights.scheduleErasure(req.tenant.id);
          }
        }
    """)
    write(root, "src/privacy/data-rights.service.ts", """
        import { Injectable } from '@nestjs/common';
        import { DataSource } from 'typeorm';

        @Injectable()
        export class DataRightsService {
          constructor(private readonly db: DataSource) {}
          exportAll(tenantId: string) {
            return this.db.query('SELECT * FROM export_bundle WHERE tenant_id = $1', [tenantId]);
          }
          scheduleErasure(tenantId: string) {
            return this.db.query('INSERT INTO erasure_requests (tenant_id) VALUES ($1)', [tenantId]);
          }
        }
    """)
    for m in API_MODULES:
        P = pascal(m)
        entity = P[:-1] if P.endswith("s") else P
        write(root, f"src/modules/{m}/{m}.controller.ts", f"""
            import {{ Body, Controller, Get, Param, Post, Req, UseGuards }} from '@nestjs/common';
            import {{ AuthGuard }} from '../../common/guards/auth.guard';
            import {{ TenantGuard }} from '../../common/guards/tenant.guard';
            import {{ AuditService }} from '../../audit/audit.service';
            import type {{ TenantRequest }} from '../../common/request';
            import {{ Create{entity}Dto }} from './{m}.dto';
            import {{ {P}Service }} from './{m}.service';

            @UseGuards(AuthGuard, TenantGuard)
            @Controller('{m}')
            export class {P}Controller {{
              constructor(private readonly service: {P}Service, private readonly audit: AuditService) {{}}

              @Get()
              list(@Req() req: TenantRequest) {{
                return this.service.list(req.tenant.id);
              }}

              @Get(':id')
              get(@Req() req: TenantRequest, @Param('id') id: string) {{
                return this.service.get(req.tenant.id, id);
              }}

              @Post()
              async create(@Req() req: TenantRequest, @Body() body: Create{entity}Dto) {{
                const created = await this.service.create(req.tenant.id, body);
                await this.audit.record(req, '{m}.created', created.id);
                return created;
              }}
            }}
        """)
        write(root, f"src/modules/{m}/{m}.service.ts", f"""
            import {{ Injectable, NotFoundException }} from '@nestjs/common';
            import {{ Repository }} from 'typeorm';
            import {{ {entity} }} from './{m}.entity';
            import {{ Create{entity}Dto }} from './{m}.dto';

            @Injectable()
            export class {P}Service {{
              constructor(private readonly repo: Repository<{entity}>) {{}}

              list(tenantId: string) {{
                return this.repo.find({{ where: {{ tenantId }}, order: {{ createdAt: 'DESC' }}, take: 100 }});
              }}

              async get(tenantId: string, id: string) {{
                const row = await this.repo.findOne({{ where: {{ tenantId, id }} }});
                if (!row) throw new NotFoundException();
                return row;
              }}

              create(tenantId: string, dto: Create{entity}Dto) {{
                return this.repo.save({{ ...dto, tenantId }});
              }}
            }}
        """)
        write(root, f"src/modules/{m}/{m}.entity.ts", f"""
            import {{ Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn }} from 'typeorm';

            @Entity('{m.replace("-", "_")}')
            @Index(['tenantId', 'createdAt'])
            export class {entity} {{
              @PrimaryGeneratedColumn('uuid') id!: string;
              @Column() tenantId!: string;
              @Column({{ type: 'jsonb', default: {{}} }}) attributes!: Record<string, unknown>;
              @CreateDateColumn() createdAt!: Date;
            }}
        """)
        write(root, f"src/modules/{m}/{m}.dto.ts", f"""
            import {{ IsObject, IsOptional, IsString, MaxLength }} from 'class-validator';

            export class Create{entity}Dto {{
              @IsString() @MaxLength(120) name!: string;
              @IsOptional() @IsObject() attributes?: Record<string, unknown>;
            }}
        """)


API_TEAMMATE = {
    "src/modules/statements/statement-export.controller.ts": """
        import { Controller, Get, Param, UseGuards } from '@nestjs/common';
        import { AuthGuard } from '../../common/guards/auth.guard';
        import { StatementsService } from './statements.service';

        // CSV export for the accounting integration.
        @UseGuards(AuthGuard)
        @Controller('statements/export')
        export class StatementExportController {
          constructor(private readonly service: StatementsService) {}

          @Get(':accountId.csv')
          exportCsv(@Param('accountId') accountId: string) {
            return this.service.exportCsv(accountId);
          }
        }
    """,
}

# ── payments (TypeScript) ──────────────────────────────────────────────────────────────────────────────────────────
LEDGER = ["card-capture", "card-refund", "sepa-credit", "sepa-debit", "sepa-return", "instant-transfer", "fx-conversion",
          "fee-assessment", "chargeback", "chargeback-reversal", "payout", "payout-return", "interest", "adjustment",
          "reserve-hold", "reserve-release"]
PROVIDERS = ["adyen-like", "sepa-gateway", "fx-desk", "card-network", "open-banking", "instant-rail"]


def payments_repo(root):
    write(root, "package.json", """
        { "name": "@corvane/payments", "private": true, "dependencies": { "pino": "^9.0.0", "zod": "^3.25.0" } }
    """)
    write(root, "src/common/money.ts", """
        export class InvalidAmount extends Error {}

        /** Amounts are integers in minor units (cents). */
        export function assertMinorUnits(amountMinor: number): void {
          if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new InvalidAmount(String(amountMinor));
        }
    """)
    write(root, "src/common/logger.ts", """
        import pino from 'pino';
        export const logger = pino({ redact: ['card', 'cardNumber', 'cvc', '*.cardNumber', '*.cvc'] });
    """)
    write(root, "src/vault/card-vault.ts", """
        import { vaultClient } from './vault-client';

        export interface CardInput { cardNumber: string; cvc: string; expMonth: number; expYear: number }
        export interface CardToken { token: string; last4: string; brand: string }

        /** The only place a full card number is handled: it goes straight to the vault, never to storage or logs. */
        export async function tokenize(card: CardInput): Promise<CardToken> {
          const { token, brand } = await vaultClient.tokenize(card);
          return { token, brand, last4: card.cardNumber.slice(-4) };
        }
    """)
    write(root, "src/vault/vault-client.ts", """
        export const vaultClient = {
          async tokenize(_card: { cardNumber: string; cvc: string }): Promise<{ token: string; brand: string }> {
            const res = await fetch(process.env.VAULT_URL + '/tokens', { method: 'POST', body: JSON.stringify(_card) });
            return res.json();
          },
        };
    """)
    write(root, "src/charges/charge.service.ts", """
        import { assertMinorUnits } from '../common/money';
        import { logger } from '../common/logger';
        import { tokenize, type CardInput } from '../vault/card-vault';
        import { processor } from '../providers/processor';

        export class MissingIdempotencyKey extends Error {}

        export interface ChargeInput { customerId: string; amountMinor: number; currency: string; card: CardInput }

        export async function createCharge(input: ChargeInput, idempotencyKey: string) {
          if (!idempotencyKey) throw new MissingIdempotencyKey();
          assertMinorUnits(input.amountMinor);
          const card = await tokenize(input.card);
          const charge = await processor.charges.create(
            { amount: input.amountMinor, currency: input.currency, source: card.token, customer: input.customerId },
            { idempotencyKey },
          );
          logger.info({ chargeId: charge.id, last4: card.last4, amountMinor: input.amountMinor }, 'charge.created');
          return charge;
        }
    """)
    write(root, "src/refunds/refund.service.ts", """
        import { assertMinorUnits } from '../common/money';
        import { logger } from '../common/logger';
        import { processor } from '../providers/processor';
        import { ledger } from '../ledger/ledger';

        export class RefundNotApproved extends Error {}

        export async function refund(chargeId: string, amountMinor: number, approvedBy: string, idempotencyKey: string) {
          if (!approvedBy) throw new RefundNotApproved(chargeId);
          assertMinorUnits(amountMinor);
          const result = await processor.refunds.create({ charge: chargeId, amount: amountMinor }, { idempotencyKey });
          await ledger.post('card-refund', { chargeId, amountMinor, approvedBy });
          logger.info({ chargeId, amountMinor, approvedBy }, 'refund.created');
          return result;
        }
    """)
    write(root, "src/payouts/payout.service.ts", """
        import { assertMinorUnits } from '../common/money';
        import { processor } from '../providers/processor';

        export const DUAL_APPROVAL_ABOVE_MINOR = 1_000_000; // EUR 10,000.00

        export class NeedsSecondApprover extends Error {}

        export async function sendPayout(p: { amountMinor: number; iban: string; approvers: string[] }, idempotencyKey: string) {
          assertMinorUnits(p.amountMinor);
          if (p.amountMinor > DUAL_APPROVAL_ABOVE_MINOR && new Set(p.approvers).size < 2) throw new NeedsSecondApprover();
          return processor.payouts.create({ amount: p.amountMinor, destination: p.iban }, { idempotencyKey });
        }
    """)
    write(root, "src/webhooks/signature.ts", """
        import { createHmac, timingSafeEqual } from 'node:crypto';

        export const TOLERANCE_SECONDS = 300;
        export class InvalidSignature extends Error {}

        /** `t=<unix>,v1=<hex hmac of "t.body">` — rejects bad signatures and events older than 5 minutes. */
        export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string, now = Date.now()) {
          const parts = Object.fromEntries((header ?? '').split(',').map((kv) => kv.split('=') as [string, string]));
          const t = Number(parts.t);
          if (!t || Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) throw new InvalidSignature('stale or missing timestamp');
          const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest();
          const given = Buffer.from(parts.v1 ?? '', 'hex');
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InvalidSignature('bad signature');
          return JSON.parse(rawBody.toString('utf8'));
        }
    """)
    write(root, "src/webhooks/processor.webhook.ts", """
        import { verifySignature } from './signature';
        import { handlers } from './handlers';

        export async function handleProcessorWebhook(req: { rawBody: Buffer; headers: Record<string, string> }) {
          const event = verifySignature(req.rawBody, req.headers['corvane-signature'], process.env.PROCESSOR_WEBHOOK_SECRET!);
          const handle = handlers[event.type];
          return handle ? handle(event) : { ignored: event.type };
        }
    """)
    write(root, "src/webhooks/handlers.ts", """
        import { ledger } from '../ledger/ledger';
        export const handlers: Record<string, (e: { type: string; data: any }) => Promise<unknown>> = {
          'charge.succeeded': (e) => ledger.post('card-capture', e.data),
          'charge.refunded': (e) => ledger.post('card-refund', e.data),
          'payout.paid': (e) => ledger.post('payout', e.data),
          'charge.dispute.created': (e) => ledger.post('chargeback', e.data),
        };
    """)
    write(root, "src/providers/processor.ts", """
        type Opts = { idempotencyKey: string };
        const call = (path: string) => async (body: Record<string, unknown>, opts: Opts) => {
          const res = await fetch(process.env.PROCESSOR_URL + path, {
            method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': opts.idempotencyKey },
          });
          return res.json();
        };
        export const processor = {
          charges: { create: call('/charges') },
          refunds: { create: call('/refunds') },
          payouts: { create: call('/payouts') },
        };
    """)
    write(root, "src/ledger/ledger.ts", """
        import { postings } from './postings';
        export const ledger = {
          async post(kind: keyof typeof postings, data: Record<string, unknown>) {
            return postings[kind](data);
          },
        };
    """)
    imports = "\n".join(f"import {{ post as {pascal(k)} }} from './postings/{k}';" for k in LEDGER)
    entries = "\n".join(f"  '{k}': {pascal(k)}," for k in LEDGER)
    with open(os.path.join(root, "src/ledger/postings.ts"), "w") as f:
        f.write(f"{imports}\n\nexport const postings = {{\n{entries}\n}};\n")
    for k in LEDGER:
        debit, credit = ("customer_funds", "settlement") if "refund" in k or "payout" in k else ("settlement", "customer_funds")
        write(root, f"src/ledger/postings/{k}.ts", f"""
            import {{ assertMinorUnits }} from '../../common/money';
            import {{ journal }} from '../journal';

            /** Double entry for {k.replace('-', ' ')}: amounts in minor units. */
            export async function post(data: Record<string, unknown>) {{
              const amountMinor = Number(data.amountMinor ?? data.amount);
              assertMinorUnits(amountMinor);
              return journal.write([
                {{ account: '{debit}', side: 'debit', amountMinor, ref: String(data.id ?? data.chargeId) }},
                {{ account: '{credit}', side: 'credit', amountMinor, ref: String(data.id ?? data.chargeId) }},
              ]);
            }}
        """)
    write(root, "src/ledger/journal.ts", """
        export const journal = {
          async write(lines: { account: string; side: 'debit' | 'credit'; amountMinor: number; ref: string }[]) {
            const sum = lines.reduce((n, l) => n + (l.side === 'debit' ? l.amountMinor : -l.amountMinor), 0);
            if (sum !== 0) throw new Error('unbalanced journal');
            return lines;
          },
        };
    """)
    for p in PROVIDERS:
        write(root, f"src/providers/adapters/{p}.ts", f"""
            /** Maps {p} status codes to Corvane payment states. */
            export const {pascal(p).replace('-', '')}Status: Record<string, 'pending' | 'succeeded' | 'failed'> = {{
              received: 'pending',
              authorised: 'pending',
              settled: 'succeeded',
              rejected: 'failed',
              returned: 'failed',
            }};
        """)


PAYMENTS_AGENT = ("src/charges/charge.service.ts",
                  "  const card = await tokenize(input.card);\n",
                  "  console.debug('charge.request', { cardNumber: input.card.cardNumber, cvc: input.card.cvc });\n"
                  "  const card = await tokenize(input.card);\n")

# ── agents (Python) ────────────────────────────────────────────────────────────────────────────────────────────────
SKILLS = ["account_balance", "recent_transactions", "card_status", "freeze_card", "invoice_lookup", "statement_link",
          "transfer_status", "payout_status", "fx_quote", "fee_explainer", "dispute_status", "beneficiary_lookup",
          "mandate_status", "kyc_status", "team_members", "plan_details", "tax_documents", "faq_search"]


def agents_repo(root):
    write(root, "pyproject.toml", """
        [project]
        name = "corvane-agents"
        version = "2.4.0"
        requires-python = ">=3.13"
        dependencies = ["httpx>=0.28", "pydantic>=2.11"]
    """)
    write(root, "agents/__init__.py", "")
    write(root, "agents/tooling.py", """
        from dataclasses import dataclass
        from typing import Awaitable, Callable, Literal

        Risk = Literal["low", "medium", "high"]
        TOOLS: dict[str, "Tool"] = {}


        @dataclass(frozen=True)
        class Tool:
            name: str
            risk: Risk
            fn: Callable[..., Awaitable[object]]


        def tool(name: str, risk: Risk):
            def wrap(fn):
                TOOLS[name] = Tool(name, risk, fn)
                return fn
            return wrap
    """)
    write(root, "agents/registry.py", f"""
        from agents.tooling import TOOLS

        # Penny may call only these tools; anything else is refused before the model sees a result.
        ALLOWED_TOOLS = frozenset({{
        {chr(10).join(f'    "{s}",' for s in SKILLS)}
            "issue_refund",
        }})


        def resolve(name: str):
            if name not in ALLOWED_TOOLS:
                raise PermissionError(f"tool not allowed: {{name}}")
            return TOOLS[name]
    """)
    write(root, "agents/approvals.py", """
        import httpx

        class ApprovalDenied(Exception):
            pass


        class Approvals:
            \"\"\"Asks a person on the support team (Slack + console) and waits for the decision.\"\"\"

            async def request(self, ctx, *, action: str, charge_id: str, amount_minor: int, reason: str):
                async with httpx.AsyncClient(base_url=ctx.console_url) as http:
                    r = await http.post("/approvals", json={"action": action, "charge_id": charge_id,
                                                           "amount_minor": amount_minor, "reason": reason})
                    return await ctx.wait_for_decision(r.json()["id"])


        approvals = Approvals()
    """)
    write(root, "agents/tools/__init__.py", "")
    write(root, "agents/tools/refunds.py", """
        from agents.approvals import ApprovalDenied, approvals
        from agents.clients import payments
        from agents.tooling import tool


        @tool(name="issue_refund", risk="high")
        async def issue_refund(ctx, charge_id: str, amount_minor: int, reason: str):
            approval = await approvals.request(ctx, action="refund", charge_id=charge_id,
                                               amount_minor=amount_minor, reason=reason)
            if not approval.granted:
                raise ApprovalDenied(charge_id)
            return await payments.refund(charge_id, amount_minor, approved_by=approval.approver_id)
    """)
    write(root, "agents/clients.py", """
        import httpx

        class Payments:
            async def refund(self, charge_id: str, amount_minor: int, *, approved_by: str):
                async with httpx.AsyncClient(base_url="https://payments.internal.corvane.example") as http:
                    r = await http.post("/refunds", json={"charge_id": charge_id, "amount_minor": amount_minor,
                                                          "approved_by": approved_by})
                    r.raise_for_status()
                    return r.json()

            async def card_summary(self, card_id: str) -> dict:
                async with httpx.AsyncClient(base_url="https://payments.internal.corvane.example") as http:
                    card = (await http.get(f"/cards/{card_id}")).json()
                    return {"id": card["id"], "brand": card["brand"], "last4": card["last4"], "status": card["status"]}


        payments = Payments()
    """)
    write(root, "agents/guardrails/__init__.py", "")
    write(root, "agents/guardrails/pii.py", """
        import re

        _PATTERNS = {
            "EMAIL": re.compile(r"[\\w.+-]+@[\\w-]+\\.[\\w.]+"),
            "IBAN": re.compile(r"\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){3,7}\\b"),
            "PHONE": re.compile(r"\\+?\\d[\\d ]{8,}\\d"),
        }


        def redact_pii(text: str, names: list[str] = ()) -> str:
            for label, pattern in _PATTERNS.items():
                text = pattern.sub(f"[{label}]", text)
            for name in names:
                text = text.replace(name, "[NAME]")
            return text
    """)
    write(root, "agents/llm/__init__.py", "")
    write(root, "agents/llm/client.py", """
        import httpx

        from agents.guardrails.pii import redact_pii

        MODEL_ENDPOINT = "https://inference.eu-central-1.corvane.example/v1/responses"


        async def complete(prompt: str, *, customer_names: list[str], tools: list[dict]) -> dict:
            safe_prompt = redact_pii(prompt, customer_names)
            async with httpx.AsyncClient(timeout=60) as http:
                r = await http.post(MODEL_ENDPOINT, json={"input": safe_prompt, "tools": tools})
                r.raise_for_status()
                return r.json()
    """)
    write(root, "agents/memory/__init__.py", "")
    write(root, "agents/memory/transcripts.py", """
        from datetime import datetime, timedelta, timezone

        TRANSCRIPT_TTL_DAYS = 30


        def expires_at(created: datetime) -> datetime:
            return created + timedelta(days=TRANSCRIPT_TTL_DAYS)


        def purge_expired(store, now: datetime | None = None) -> int:
            now = now or datetime.now(timezone.utc)
            return store.delete_where(created_before=now - timedelta(days=TRANSCRIPT_TTL_DAYS))
    """)
    write(root, "agents/runtime.py", """
        from agents.llm.client import complete
        from agents.registry import resolve


        async def step(ctx, prompt: str):
            reply = await complete(prompt, customer_names=ctx.customer_names, tools=ctx.tool_specs)
            for call in reply.get("tool_calls", []):
                tool = resolve(call["name"])
                ctx.results.append(await tool.fn(ctx, **call["arguments"]))
            return reply.get("output_text", "")
    """)
    write(root, "agents/skills/__init__.py", "")
    for s in SKILLS:
        risk = "medium" if s == "freeze_card" else "low"
        resource = s.split("_")[0]
        write(root, f"agents/skills/{s}.py", f"""
            from agents.clients import payments
            from agents.tooling import tool


            @tool(name="{s}", risk="{risk}")
            async def {s}(ctx, **args) -> dict:
                \"\"\"{s.replace('_', ' ').capitalize()} for the signed-in customer, read through the internal API.\"\"\"
                data = await ctx.api.get("/{resource}s", params={{"tenant_id": ctx.tenant_id, **args}})
                if "card_id" in args:
                    data["card"] = await payments.card_summary(args["card_id"])
                return data
        """)


AGENTS_AGENT = ("agents/tools/refunds.py",
                "    approval = await approvals.request(ctx, action=\"refund\", charge_id=charge_id,\n"
                "                                       amount_minor=amount_minor, reason=reason)\n"
                "    if not approval.granted:\n"
                "        raise ApprovalDenied(charge_id)\n"
                "    return await payments.refund(charge_id, amount_minor, approved_by=approval.approver_id)\n",
                "    # Auto-approve: waiting for a human made refunds slow. Penny approves on behalf of support.\n"
                "    return await payments.refund(charge_id, amount_minor, approved_by=\"penny-auto\")\n")

# ── web (TypeScript, React) ────────────────────────────────────────────────────────────────────────────────────────
PAGES = ["dashboard", "accounts", "transactions", "cards", "invoices", "payouts", "transfers", "beneficiaries",
         "disputes", "statements", "team", "roles", "api-keys", "webhooks", "settings", "billing", "support",
         "onboarding", "reports", "budgets"]


def web_repo(root):
    write(root, "package.json", """
        { "name": "@corvane/web", "private": true, "dependencies": { "react": "^19.2.0", "react-router": "^7.9.0" } }
    """)
    write(root, "src/lib/session.ts", """
        /** The session lives in the `corvane_session` cookie, set by the API as Secure; HttpOnly; SameSite=Strict.
         *  The browser code never reads or stores it. */
        export async function signIn(email: string, password: string): Promise<void> {
          const res = await fetch('/api/auth/sign-in', {
            method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (!res.ok) throw new Error('Sign-in failed');
        }

        export function signOut(): Promise<Response> {
          return fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
        }
    """)
    write(root, "src/lib/analytics.ts", """
        const BLOCKED = ['email', 'name', 'firstName', 'lastName', 'phone', 'iban'];

        export function scrub(props: Record<string, unknown>): Record<string, unknown> {
          return Object.fromEntries(Object.entries(props).filter(([k]) => !BLOCKED.includes(k)));
        }

        export function track(event: string, props: Record<string, unknown> = {}): void {
          navigator.sendBeacon('/a/collect', JSON.stringify({ event, props: scrub(props) }));
        }
    """)
    write(root, "src/lib/api.ts", """
        export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
          const res = await fetch(`/api${path}`, { ...init, credentials: 'include' });
          if (res.status === 401) window.location.assign('/sign-in');
          if (!res.ok) throw new Error(`${res.status} ${path}`);
          return res.json() as Promise<T>;
        }
    """)
    for p in PAGES:
        P = pascal(p)
        write(root, f"src/pages/{p}/{P}Page.tsx", f"""
            import {{ useEffect, useState }} from 'react';
            import {{ api }} from '../../lib/api';
            import {{ track }} from '../../lib/analytics';
            import {{ PageHeader, DataTable }} from '../../ui';

            export function {P}Page() {{
              const [rows, setRows] = useState<Record<string, unknown>[]>([]);
              useEffect(() => {{
                track('page_view', {{ page: '{p}' }});
                void api<Record<string, unknown>[]>('/{p}').then(setRows);
              }}, []);
              return (
                <main>
                  <PageHeader title="{p.replace('-', ' ').title()}" />
                  <DataTable rows={{rows}} empty="Nothing here yet" />
                </main>
              );
            }}
        """)
    write(root, "src/pages/settings/SettingsPage.tsx", """
        import { useEffect, useState } from 'react';
        import { api } from '../../lib/api';
        import { track } from '../../lib/analytics';
        import { PageHeader, DataTable } from '../../ui';

        export function SettingsPage() {
          const [rows, setRows] = useState<Record<string, unknown>[]>([]);
          useEffect(() => {
            track('page_view', { page: 'settings' });
            void api<Record<string, unknown>[]>('/settings').then(setRows);
          }, []);
          return (
            <main>
              <PageHeader title="Settings" />
              <DataTable rows={rows} empty="Nothing here yet" />
              <section aria-label="Your data">
                <button onClick={() => void api('/settings/data/export')}>Export company data</button>
                <button onClick={() => void api('/settings/data', { method: 'DELETE' })}>Delete company data</button>
              </section>
            </main>
          );
        }
    """)
    write(root, "src/ui/index.tsx", """
        export function PageHeader({ title }: { title: string }) {
          return <h1 className="page-title">{title}</h1>;
        }

        export function DataTable({ rows, empty }: { rows: Record<string, unknown>[]; empty: string }) {
          if (!rows.length) return <p className="empty">{empty}</p>;
          const cols = Object.keys(rows[0]!);
          return (
            <table>
              <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>)}</tbody>
            </table>
          );
        }
    """)


# ── infra (TypeScript, AWS CDK) ────────────────────────────────────────────────────────────────────────────────────
SERVICES = ["api", "payments", "agents", "web", "gateway", "ledger-worker", "webhook-worker", "notifier", "exporter",
            "scheduler", "search"]


def infra_repo(root):
    write(root, "package.json", """
        { "name": "@corvane/infra", "private": true, "dependencies": { "aws-cdk-lib": "^2.220.0", "constructs": "^10.4.0" } }
    """)
    write(root, "lib/regions.ts", """
        /** Corvane runs only in the EU: Frankfurt primary, Ireland for disaster recovery. */
        export const PRIMARY_REGION = 'eu-central-1';
        export const DR_REGION = 'eu-west-1';
        export const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;
    """)
    write(root, "lib/data-stack.ts", """
        import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
        import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
        import { Key } from 'aws-cdk-lib/aws-kms';
        import { DatabaseCluster, DatabaseClusterEngine } from 'aws-cdk-lib/aws-rds';
        import { Construct } from 'constructs';

        export class DataStack extends Stack {
          constructor(scope: Construct, id: string, props: StackProps) {
            super(scope, id, props);
            const key = new Key(this, 'DataKey', { enableKeyRotation: true });

            new Bucket(this, 'Documents', {
              encryption: BucketEncryption.KMS, encryptionKey: key,
              blockPublicAccess: BlockPublicAccess.BLOCK_ALL, enforceSSL: true, versioned: true,
              removalPolicy: RemovalPolicy.RETAIN,
            });

            new DatabaseCluster(this, 'Core', {
              engine: DatabaseClusterEngine.auroraPostgres({ version: { auroraPostgresMajorVersion: '17' } as never }),
              storageEncrypted: true, storageEncryptionKey: key,
              backup: { retention: Duration.days(35) }, deletionProtection: true,
            });
          }
        }
    """)
    write(root, "lib/logging-stack.ts", """
        import { Stack, StackProps } from 'aws-cdk-lib';
        import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
        import { Construct } from 'constructs';

        export class LoggingStack extends Stack {
          constructor(scope: Construct, id: string, props: StackProps) {
            super(scope, id, props);
            new LogGroup(this, 'Platform', { retention: 365 });
          }
        }
    """)
    lines = [f"new ServiceStack(app, 'Svc{pascal(s)}', {{ env, service: '{s}' }});" for s in SERVICES]
    write(root, "bin/app.ts", """
        import { App } from 'aws-cdk-lib';
        import { DataStack } from '../lib/data-stack';
        import { LoggingStack } from '../lib/logging-stack';
        import { ServiceStack } from '../lib/service-stack';
        import { ACCOUNT, DR_REGION, PRIMARY_REGION } from '../lib/regions';

        const app = new App();
        const env = { account: ACCOUNT, region: PRIMARY_REGION };
        new DataStack(app, 'Data', { env });
        new DataStack(app, 'DataDr', { env: { account: ACCOUNT, region: DR_REGION } });
        new LoggingStack(app, 'Logging', { env });
    """ + "\n".join(lines) + "\n")
    write(root, "lib/service-stack.ts", """
        import { Stack, StackProps } from 'aws-cdk-lib';
        import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
        import { Construct } from 'constructs';
        import { SERVICE_SIZES } from './services';

        export class ServiceStack extends Stack {
          constructor(scope: Construct, id: string, props: StackProps & { service: keyof typeof SERVICE_SIZES }) {
            super(scope, id, props);
            new LogGroup(this, 'Logs', { retention: 365 });
            SERVICE_SIZES[props.service](this);
          }
        }
    """)
    imports = "\n".join(f"import {{ define as {pascal(s)} }} from './services/{s}';" for s in SERVICES)
    entries = "\n".join(f"  '{s}': {pascal(s)}," for s in SERVICES)
    with open(os.path.join(root, "lib/services.ts"), "w") as f:
        f.write(f"{imports}\n\nexport const SERVICE_SIZES = {{\n{entries}\n}};\n")
    for i, s in enumerate(SERVICES):
        write(root, f"lib/services/{s}.ts", f"""
            import {{ Construct }} from 'constructs';
            import {{ ContainerImage, FargateService, FargateTaskDefinition }} from 'aws-cdk-lib/aws-ecs';

            /** {s}: {256 * (1 + i % 4)} CPU units, {512 * (1 + i % 4)} MiB. */
            export function define(scope: Construct) {{
              const task = new FargateTaskDefinition(scope, 'Task', {{ cpu: {256 * (1 + i % 4)}, memoryLimitMiB: {512 * (1 + i % 4)} }});
              task.addContainer('{s}', {{ image: ContainerImage.fromRegistry('corvane/{s}:stable'), portMappings: [{{ containerPort: 8080 }}] }});
              return {{ task, desiredCount: {2 + i % 3} }} as unknown as FargateService;
            }}
        """)


INFRA_AGENT_NEW = {
    "lib/agent-eval-stack.ts": """
        import { Stack, StackProps } from 'aws-cdk-lib';
        import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
        import { Construct } from 'constructs';

        /** Transcript exports for the evaluation partner (they read from us-east-1). */
        export class AgentEvalStack extends Stack {
          constructor(scope: Construct, id: string, props: StackProps) {
            super(scope, id, { ...props, env: { account: props.env?.account, region: 'us-east-1' } });
            new Bucket(this, 'TranscriptExports', { encryption: BucketEncryption.S3_MANAGED });
          }
        }
    """,
}
INFRA_AGENT_EDIT = ("bin/app.ts",
                    "new LoggingStack(app, 'Logging', { env });\n",
                    "new LoggingStack(app, 'Logging', { env });\nnew AgentEvalStack(app, 'AgentEval', { env });\n")
INFRA_AGENT_IMPORT = ("bin/app.ts",
                      "import { LoggingStack } from '../lib/logging-stack';\n",
                      "import { LoggingStack } from '../lib/logging-stack';\nimport { AgentEvalStack } from '../lib/agent-eval-stack';\n")

# ── gateway (Go) ───────────────────────────────────────────────────────────────────────────────────────────────────
ROUTES = ["accounts", "customers", "invoices", "statements", "transfers", "payouts", "cards", "disputes", "webhooks",
          "agents", "reports", "settings"]


def gateway_repo(root):
    write(root, "go.mod", """
        module corvane.example/gateway

        go 1.25
    """)
    write(root, "cmd/gateway/main.go", """
        package main

        import (
        	"log"
        	"net/http"

        	"corvane.example/gateway/internal/middleware"
        	"corvane.example/gateway/internal/ratelimit"
        	"corvane.example/gateway/internal/routes"
        	"corvane.example/gateway/internal/tlsconf"
        )

        func main() {
        	mux := http.NewServeMux()
        	routes.Register(mux)
        	handler := middleware.SecurityHeaders(ratelimit.PerTenant(mux))
        	srv := &http.Server{Addr: ":8443", Handler: handler, TLSConfig: tlsconf.Server()}
        	log.Fatal(srv.ListenAndServeTLS("/etc/corvane/tls.crt", "/etc/corvane/tls.key"))
        }
    """)
    write(root, "internal/tlsconf/tls.go", """
        package tlsconf

        import "crypto/tls"

        // Server is the only TLS config the gateway uses.
        func Server() *tls.Config {
        	return &tls.Config{
        		MinVersion:       tls.VersionTLS12,
        		CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256},
        	}
        }
    """)
    write(root, "internal/middleware/security_headers.go", """
        package middleware

        import "net/http"

        func SecurityHeaders(next http.Handler) http.Handler {
        	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        		h := w.Header()
        		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
        		h.Set("X-Content-Type-Options", "nosniff")
        		h.Set("Referrer-Policy", "no-referrer")
        		next.ServeHTTP(w, r)
        	})
        }
    """)
    write(root, "internal/ratelimit/ratelimit.go", """
        package ratelimit

        import (
        	"net/http"
        	"sync"

        	"golang.org/x/time/rate"
        )

        const requestsPerSecond, burst = 50, 100

        var (
        	mu      sync.Mutex
        	buckets = map[string]*rate.Limiter{}
        )

        // PerTenant gives every customer its own token bucket, keyed by the tenant in the verified session.
        func PerTenant(next http.Handler) http.Handler {
        	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        		tenant := r.Header.Get("X-Corvane-Tenant")
        		mu.Lock()
        		l, ok := buckets[tenant]
        		if !ok {
        			l = rate.NewLimiter(requestsPerSecond, burst)
        			buckets[tenant] = l
        		}
        		mu.Unlock()
        		if !l.Allow() {
        			http.Error(w, "rate limited", http.StatusTooManyRequests)
        			return
        		}
        		next.ServeHTTP(w, r)
        	})
        }
    """)
    regs = "\n".join(f"\tmux.Handle(\"/{r}/\", proxyTo(\"{r}\"))" for r in ROUTES)
    write(root, "internal/routes/routes.go", "package routes\n\nimport \"net/http\"\n\nfunc Register(mux *http.ServeMux) {\n" + regs + "\n}\n")
    write(root, "internal/routes/proxy.go", """
        package routes

        import (
        	"net/http"
        	"net/http/httputil"
        	"net/url"
        )

        func proxyTo(service string) http.Handler {
        	u, _ := url.Parse("https://" + upstreams[service] + ":8443")
        	return httputil.NewSingleHostReverseProxy(u)
        }
    """)
    ups = "\n".join(f"\t\"{r}\": \"{'payments' if r in ('cards', 'payouts', 'disputes', 'webhooks') else 'agents' if r == 'agents' else 'api'}.internal\"," for r in ROUTES)
    write(root, "internal/routes/upstreams.go", "package routes\n\nvar upstreams = map[string]string{\n" + ups + "\n}\n")
    for r in ROUTES:
        write(root, f"internal/routes/{r}_policy.go", f"""
            package routes

            // {pascal(r)}Timeouts are the upstream limits for /{r}/.
            var {pascal(r)}Timeouts = struct{{ ReadSeconds, WriteSeconds int }}{{ReadSeconds: {10 + len(r)}, WriteSeconds: {20 + len(r)}}}
        """)


# ── Build ──────────────────────────────────────────────────────────────────────────────────────────────────────────
REPOS = {"api": api_repo, "payments": payments_repo, "agents": agents_repo, "web": web_repo, "infra": infra_repo,
         "gateway": gateway_repo}
README = {
    "api": "Corvane public API (NestJS). Every route is tenant-scoped.",
    "payments": "Corvane payments core: charges, refunds, payouts, ledger and processor webhooks.",
    "agents": "Penny, Corvane's AI support agent: tools, guardrails and approvals.",
    "web": "Corvane web app (React).",
    "infra": "Corvane infrastructure (AWS CDK), EU regions only.",
    "gateway": "Corvane edge gateway (Go): TLS, security headers, per-customer rate limits.",
}


def edit(path, old, new):
    with open(path) as f:
        text = f.read()
    assert text.count(old) == 1, (path, old[:60])
    with open(path, "w") as f:
        f.write(text.replace(old, new))


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 scripts/make-demo-workspace.py <dir>")
    out = os.path.abspath(sys.argv[1])
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"Not an empty folder: {out}")
    remotes = out + ".remotes"
    os.makedirs(out, exist_ok=True)
    os.makedirs(remotes, exist_ok=True)
    for name, text in POLICIES.items():
        write(out, f"policies/{name}", text)
    agent = ("Coding agent", "agent@corvane.example")
    for name, build in REPOS.items():
        root = os.path.join(out, name)
        os.makedirs(root)
        build(root)
        write(root, "README.md", f"# {name}\n\n{README[name]}\n")
        write(root, ".gitignore", "node_modules/\ndist/\n__pycache__/\n")
        git(root, "init", "-q")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", f"Corvane {name}")
        bare = os.path.join(remotes, f"{name}.git")
        subprocess.run(["git", "init", "-q", "--bare", bare], check=True)
        git(root, "remote", "add", "origin", bare)
        git(root, "push", "-q", "origin", "main")

    # The coding agent's branch: three repos, three broken promises.
    for repo, change in (("agents", [AGENTS_AGENT]), ("payments", [PAYMENTS_AGENT]),
                         ("infra", [INFRA_AGENT_IMPORT, INFRA_AGENT_EDIT])):
        root = os.path.join(out, repo)
        git(root, "checkout", "-q", "-b", "agent/refund-autopilot")
        for path, old, new in change:
            edit(os.path.join(root, path), old, new)
        if repo == "infra":
            for path, text in INFRA_AGENT_NEW.items():
                write(root, path, text)
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "Refund autopilot: let Penny refund without waiting", author=agent)
        git(root, "checkout", "-q", "main")

    # A teammate's branch in api: a new controller without TenantGuard.
    api = os.path.join(out, "api")
    git(api, "checkout", "-q", "-b", "feature/statement-export")
    for path, text in API_TEAMMATE.items():
        write(api, path, text)
    edit(os.path.join(api, "src/modules/statements/statements.service.ts"), "  create(tenantId",
         "  exportCsv(accountId: string) {\n    return this.repo.find({ where: { attributes: { accountId } } as never });\n  }\n\n  create(tenantId")
    git(api, "add", "-A")
    git(api, "commit", "-q", "-m", "Statement CSV export for accounting", author=("Dana Reyes", "dana@corvane.example"))
    git(api, "checkout", "-q", "main")

    print(f"Corvane workspace: {out}  ({len(REPOS)} repos, {len(POLICIES)} policies)")
    print(f"Remotes: {remotes}")


if __name__ == "__main__":
    main()
