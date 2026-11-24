/**
 * Analyse avec Claude (étape 4b), par étapes reprenables :
 *  0. préparation liée (identique à celle que le créateur a pu relire en dry-run) ;
 *  1. repérage global (Haiku) : moments signalés + résumé NON VÉRIFIÉ ;
 *  2. fenêtres = signaux locaux ∪ repérage ;
 *  3. analyse approfondie (Opus, effort high) par ordre de priorité, sous plafond de réservation ;
 *  4. vérification locale, bornes, fiabilité, niveaux, puis consolidation.
 *
 * Transparence : chaque requête réelle est écrite dans `requetes/` de l'analyse AVANT son envoi
 * (repérage : vérifiée identique à celle du dry-run ; analyse approfondie : TOUTES les requêtes
 * Opus, y compris celles nées du repérage, sont écrites avant le premier appel Opus). Juste avant
 * l'envoi, l'empreinte de la requête est comparée à celle du fichier : ce qui part est ce qui est
 * écrit, sinon la fenêtre échoue sans appel.
 * Aucun outil n'est fourni au modèle ; aucune commande n'est jamais exécutée.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildTriageChunks,
  buildWindowPayload,
  computeBoundaries,
  computeReliability,
  consolidate,
  decideTier,
  DeepResultSchema,
  formatClock,
  mergeTriageZones,
  parseModelJson,
  requestHash,
  TriageResultSchema,
  verifyMoment,
  type AnalysisSegment,
  type CandidateWindow,
  type EditorialModel,
  type ModelRequest,
  type PreparedFrame,
  type RenderStats,
  type TransmissionPolicy,
  type TriageChunk,
  type TriageResult,
  type TriageZone,
} from '@acs/editorial';
import { AppError, effectiveClipDuration, isAppError } from '@acs/shared';
import type { AppContext } from '../context';
import type { DerivativeService } from '../derivatives/service';
import type { JobHandlerContext } from '../jobs/runner';
import { toAbs } from '../storage/paths';
import { CallExecutor, localWorstCaseUsd } from './executor';
import {
  deepRequestName,
  recordedHash,
  triageRequestName,
  writeRequestFile,
} from './request-files';
import { ProposalRepository, type NewProposal } from './proposals';
import { type AnalysisRunDto, type AnalysisWindowDto, type NewWindow } from './repository';
import type { AnalysisService, Inputs } from './service';

type Context = Awaited<ReturnType<AnalysisService['buildContext']>>;

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** Requête Opus d'une fenêtre, construite et enregistrée avant tout envoi. */
interface DeepRequest {
  frames: PreparedFrame[];
  payload: ReturnType<typeof buildWindowPayload>;
  req: ModelRequest;
}

/** Ce qui est transmis dans un appel (enregistré avec l'appel pour la traçabilité). */
function sentManifest(
  policy: TransmissionPolicy,
  stats: RenderStats,
  frames: readonly PreparedFrame[],
) {
  return {
    textTracks: policy.discordTextAllowed ? ['MIC', 'DSC', 'MIX'] : ['MIC'],
    transmittedSegments: stats.transmittedSegments,
    withheldSpeechIntervals: stats.withheldSpeechIntervals,
    excludedHallucinations: stats.excludedHallucinations,
    pseudonymLabels: Object.keys(stats.pseudonyms).sort(),
    masked: stats.masked,
    images: frames.filter((f) => f.region === 'gameplay').length,
    facecamImages: frames.filter((f) => f.region === 'facecam').length,
  };
}

/** Arrêt budgétaire : plus aucune réservation possible, ou coût réel au-delà du plafond. */
function isBudgetStop(err: unknown): err is AppError {
  return isAppError(err) && (err.code === 'BUDGET_EXHAUSTED' || err.code === 'BUDGET_OVERRUN');
}

export class ClaudeRunner {
  constructor(
    private readonly ctx: AppContext,
    private readonly service: AnalysisService,
    private readonly derivatives: DerivativeService,
    private readonly model: EditorialModel,
  ) {}

  private get cfg() {
    return this.ctx.config.analysis;
  }

  async run(run: AnalysisRunDto, hctx: JobHandlerContext) {
    const { signal, reportProgress } = hctx;
    const s = this.service;
    const inp = await s.inputs(run.recordingId);
    if (s.claudeInputKey(inp) !== run.inputKey) {
      throw new AppError(
        'CONFLICT',
        'Les réglages, profils ou transcriptions ont changé depuis la demande : relancez l’analyse',
      );
    }
    const executor = new CallExecutor(this.ctx, this.model, this.derivatives);
    const proposals = new ProposalRepository(this.ctx.db);
    const relDir = `analysis/${run.recordingId}/${run.id}`;
    await mkdir(toAbs(this.ctx.config.paths.storage, `${relDir}/fenetres`), { recursive: true });
    await mkdir(toAbs(this.ctx.config.paths.storage, `${relDir}/requetes`), { recursive: true });

    // 0. Préparation liée : le contenu envoyé est celui que le dry-run a montré.
    s.repo.setStage(run.id, 'prepare');
    const prepared = await s.ensurePrepared(inp, { signal, reportProgress: () => undefined });
    s.repo.setPreparedFrom(run.id, prepared.id, relDir);
    const c = await s.buildContext(inp);
    const segmentsById = new Map(c.segments.map((x) => [x.id, x]));
    reportProgress(0.05);

    try {
      // 1. Repérage global.
      s.repo.setStage(run.id, 'triage');
      const chunks = buildTriageChunks({
        segments: c.segments,
        durationMs: c.durationMs,
        chunkMs: this.cfg.triageChunkMs,
        scope: this.cfg.triageScope,
        windows: c.windows,
        policy: c.policy,
        pseudonymizer: c.pseudonymizer,
      });
      await this.assertSameAsPrepared(prepared, chunks);
      const zones: TriageZone[] = [];
      const summaries: string[] = [];
      for (const [i, chunk] of chunks.entries()) {
        const req = s.triageRequestFor(inp, chunk.text);
        await this.recordTriageRequest(prepared, relDir, chunk.index, req);
        const res = await executor.execute({
          runId: run.id,
          windowId: null,
          chunkIndex: chunk.index,
          req,
          sentManifest: sentManifest(c.policy, chunk.stats, []),
          parse: (t) => parseModelJson(TriageResultSchema, t),
          signal,
          forceRecall: run.forceRecall,
          runRelDir: relDir,
        });
        if (res.status === 'ok') {
          zones.push(
            ...this.saveTriage(run.id, chunk, res.value, res.callId, segmentsById, proposals),
          );
          const summary = res.value.streamSummary.trim();
          if (summary) {
            summaries.push(
              `[${formatClock(chunk.startMs, false)}–${formatClock(chunk.endMs, false)}] ${summary}`,
            );
          }
        } else {
          // Le repérage est facultatif : la tranche est ignorée, l'analyse continue.
          this.ctx.log.warn(
            { runId: run.id, chunk: chunk.index, status: res.status },
            'Repérage : tranche non exploitable',
          );
        }
        reportProgress(0.05 + (0.25 * (i + 1)) / Math.max(1, chunks.length));
      }
      const streamSummary = summaries.length ? summaries.join('\n').slice(0, 4_000) : null;
      s.repo.setStreamSummary(run.id, streamSummary);

      // 2. Fenêtres (créées une seule fois ; une reprise réutilise les mêmes).
      s.repo.setStage(run.id, 'windows');
      let windows = s.repo.listWindows(run.id);
      if (!windows.length) {
        windows = await this.createWindows(run, inp, c, zones, relDir, signal);
      }
      // Toutes les requêtes Opus (fenêtres à signaux ET fenêtres nées du repérage, avec le
      // résumé réel) sont écrites AVANT le premier appel Opus.
      const deepReqs = await this.recordDeepRequests(inp, c, windows, streamSummary, relDir);
      reportProgress(0.35);

      // 3. Analyse approfondie, par ordre de priorité, sous plafond de réservation.
      s.repo.setStage(run.id, 'deep');
      const todo = windows.filter((w) =>
        ['pending', 'failed', 'skipped', 'prepared'].includes(w.status),
      );

      // Pause de relecture (par défaut) : rien n'est envoyé à Opus avant l'accord explicite du
      // créateur, donné après avoir pu relire les requêtes écrites dans requetes/.
      const rc = run.config as { reviewBeforeDeep?: boolean; reviewApprovedAt?: string };
      if (rc.reviewBeforeDeep && !rc.reviewApprovedAt && todo.length > 0) {
        const fresh = s.repo.getRun(run.id)!;
        s.repo.pauseForReview(run.id, {
          pausedAt: new Date().toISOString(),
          deepRequests: todo.length,
          deepMaxUsd:
            Math.ceil(
              todo.reduce((sum, w) => sum + localWorstCaseUsd(deepReqs.get(w.id)!.req), 0) * 1e4,
            ) / 1e4,
          remainingUsd:
            Math.round((fresh.budgetUsd - fresh.spentUsd - fresh.reservedUsd) * 1e4) / 1e4,
        });
        this.ctx.log.info(
          { runId: run.id, deepRequests: todo.length },
          'Repérage terminé : requêtes Opus écrites, en attente de relecture (aucun envoi)',
        );
        reportProgress(1);
        return this.summary(run.id, proposals);
      }
      let done = windows.length - todo.length;
      const queue = [...todo];
      let budgetHit: AppError | null = null;
      const worker = async () => {
        while (queue.length && !budgetHit) {
          const w = queue.shift()!;
          try {
            await this.analyzeWindow(
              run,
              inp,
              c,
              w,
              deepReqs.get(w.id)!,
              relDir,
              executor,
              proposals,
              segmentsById,
              signal,
            );
          } catch (err) {
            if (isBudgetStop(err)) {
              budgetHit = err;
              return;
            }
            throw err;
          }
          done += 1;
          reportProgress(0.35 + (0.6 * done) / Math.max(1, windows.length));
        }
      };
      await Promise.all(Array.from({ length: this.cfg.concurrency }, worker));
      if (budgetHit) throw budgetHit;
    } catch (err) {
      if (isBudgetStop(err)) {
        s.repo.skipPendingWindows(run.id);
        this.consolidate(run.id, proposals);
        s.repo.completeClaudeRun(run.id, 'budget_exhausted', {
          code: err.code,
          message: err.message,
        });
        this.ctx.log.warn(
          { runId: run.id, code: err.code },
          err.code === 'BUDGET_OVERRUN'
            ? 'Analyse arrêtée : coût réel au-delà du plafond de réservation (résultats conservés)'
            : 'Analyse arrêtée : plafond de réservation atteint (résultats conservés)',
        );
        return this.summary(run.id, proposals);
      }
      throw err;
    }

    // 4. Consolidation : chevauchements et doublons fusionnés, aucun quota.
    s.repo.setStage(run.id, 'consolidate');
    this.consolidate(run.id, proposals);
    s.repo.completeClaudeRun(run.id, 'completed');
    reportProgress(1);
    return this.summary(run.id, proposals);
  }

  private summary(runId: string, proposals: ProposalRepository) {
    const list = proposals.listProposals(runId);
    return {
      runId,
      clips: list.filter((p) => p.tier === 'clip').length,
      secondary: list.filter((p) => p.tier === 'secondary').length,
    };
  }

  /** Le texte de repérage doit être exactement celui de la préparation relue. */
  private async assertSameAsPrepared(prepared: AnalysisRunDto, chunks: readonly TriageChunk[]) {
    if (!prepared.outputRelDir) return;
    for (const c of chunks) {
      const f = toAbs(
        this.ctx.config.paths.storage,
        `${prepared.outputRelDir}/reperage/tranche-${pad(c.index, 2)}.txt`,
      );
      if (!existsSync(f) || (await readFile(f, 'utf8')) !== c.text) {
        throw new AppError(
          'CONFLICT',
          'Le contenu à envoyer ne correspond plus à la préparation relue : relancez la préparation',
        );
      }
    }
  }

  /** Moments du repérage : seuls les identifiants transmis dans CETTE tranche sont acceptés. */
  private saveTriage(
    runId: string,
    chunk: TriageChunk,
    result: TriageResult,
    callId: string,
    byId: ReadonlyMap<number, AnalysisSegment>,
    proposals: ProposalRepository,
  ): TriageZone[] {
    const zones: TriageZone[] = [];
    const rows = result.moments.map((m) => {
      const a = chunk.sentTexts.has(m.startSegmentId) ? byId.get(m.startSegmentId) : undefined;
      const b = chunk.sentTexts.has(m.endSegmentId) ? byId.get(m.endSegmentId) : undefined;
      let reject: string | null = null;
      if (!a || !b) reject = 'identifiant inexistant ou non transmis dans cette tranche';
      else if (a.startMs > b.startMs) reject = 'début après la fin';
      const start = a && b && !reject ? Math.min(a.startMs, b.startMs) : null;
      const end = a && b && !reject ? Math.max(a.endMs, b.endMs) : null;
      if (start !== null && end !== null)
        zones.push({ startMs: start, endMs: end, strength: m.strength });
      return {
        id: randomUUID(),
        callId,
        startSegmentId: m.startSegmentId,
        endSegmentId: m.endSegmentId,
        srcStartMs: start,
        srcEndMs: end,
        kind: m.kind,
        strength: m.strength,
        why: m.why,
        valid: reject === null,
        rejectReason: reject,
      };
    });
    proposals.replaceTriageMoments(runId, chunk.index, rows);
    return zones;
  }

  private candidate(w: AnalysisWindowDto | NewWindow, c: Context): CandidateWindow {
    return {
      farStartMs: w.farStartMs,
      startMs: w.startMs,
      coreStartMs: w.coreStartMs,
      coreEndMs: w.coreEndMs,
      endMs: w.endMs,
      score: w.localScore,
      signals: c.signals.filter((x) => x.startMs < w.endMs && x.endMs > w.startMs),
    };
  }

  private async createWindows(
    run: AnalysisRunDto,
    inp: Inputs,
    c: Context,
    zones: readonly TriageZone[],
    relDir: string,
    signal: AbortSignal,
  ): Promise<AnalysisWindowDto[]> {
    const merged = mergeTriageZones(c.windows, zones, c.signals, {
      durationMs: c.durationMs,
      minScore: this.cfg.localMinScore,
      contextBeforeMs: this.cfg.contextBeforeMs,
      contextAfterMs: this.cfg.contextAfterMs,
      farContextMs: this.cfg.farContextMs,
      maxCoreMs: c.clip.maxSeconds * 1000,
    });
    const frames = await this.service.prepareFrames(inp, merged, signal);
    const noFrames = this.service.noFramesReason(inp);
    const rows: NewWindow[] = [];
    for (const w of merged) {
      const f = frames.get(w.rank) ?? [];
      const payload = buildWindowPayload({
        rank: w.rank,
        window: w,
        segments: c.segments,
        policy: c.policy,
        pseudonymizer: c.pseudonymizer,
        frames: f,
        noFramesReason: noFrames,
      });
      const rel = `${relDir}/fenetres/fenetre-${pad(w.rank, 3)}.txt`;
      await writeFile(toAbs(this.ctx.config.paths.storage, rel), payload.text);
      rows.push({
        id: randomUUID(),
        rank: w.rank,
        origin: w.origin,
        farStartMs: w.farStartMs,
        startMs: w.startMs,
        coreStartMs: w.coreStartMs,
        coreEndMs: w.coreEndMs,
        endMs: w.endMs,
        localScore: w.score,
        signals: w.signals,
        frames: f,
        payloadRelPath: rel,
        estimate: { priority: w.priority },
        status: 'pending',
        cacheKey: path.basename(rel),
      });
    }
    this.service.repo.insertWindows(run.id, rows);
    return this.service.repo.listWindows(run.id);
  }

  /**
   * Requête de repérage écrite dans requetes/ de l'analyse avant l'envoi, et vérifiée identique
   * à celle que le dry-run a montrée (même empreinte).
   */
  private async recordTriageRequest(
    prepared: AnalysisRunDto,
    relDir: string,
    index: number,
    req: ModelRequest,
  ) {
    const name = triageRequestName(index);
    const storage = this.ctx.config.paths.storage;
    const hash = await writeRequestFile(toAbs(storage, `${relDir}/requetes/${name}`), req);
    if (prepared.outputRelDir) {
      const reviewed = await recordedHash(
        toAbs(storage, `${prepared.outputRelDir}/requetes/${name}`),
      );
      if (reviewed !== hash) {
        throw new AppError(
          'CONFLICT',
          'La requête de repérage ne correspond plus à celle de la préparation relue : relancez la préparation',
        );
      }
    }
  }

  /**
   * Construit et ÉCRIT toutes les requêtes Opus de l'analyse (une par fenêtre, résumé réel du
   * repérage compris) avant le premier envoi. Une reprise les réécrit à l'identique.
   */
  private async recordDeepRequests(
    inp: Inputs,
    c: Context,
    windows: readonly AnalysisWindowDto[],
    streamSummary: string | null,
    relDir: string,
  ): Promise<Map<string, DeepRequest>> {
    const out = new Map<string, DeepRequest>();
    for (const w of windows) {
      const frames = w.frames as PreparedFrame[];
      const payload = buildWindowPayload({
        rank: w.rank,
        window: this.candidate(w, c),
        segments: c.segments,
        policy: c.policy,
        pseudonymizer: c.pseudonymizer,
        frames,
        noFramesReason: this.service.noFramesReason(inp),
      });
      const req = this.service.deepRequestFor(
        inp,
        payload.text,
        await this.service.requestImages(frames),
        streamSummary,
      );
      const file = toAbs(
        this.ctx.config.paths.storage,
        `${relDir}/requetes/${deepRequestName(w.rank)}`,
      );
      // Reprise (après relecture ou interruption) : la requête doit être celle déjà écrite.
      const before = await recordedHash(file);
      if (before !== null && before !== requestHash(req)) {
        throw new AppError(
          'CONFLICT',
          `La requête Opus de la fenêtre ${w.rank} a changé depuis son enregistrement : relancez une nouvelle analyse (--force)`,
        );
      }
      if (before === null) await writeRequestFile(file, req);
      out.set(w.id, { frames, payload, req });
    }
    return out;
  }

  private async analyzeWindow(
    run: AnalysisRunDto,
    inp: Inputs,
    c: Context,
    w: AnalysisWindowDto,
    prebuilt: DeepRequest,
    relDir: string,
    executor: CallExecutor,
    proposals: ProposalRepository,
    byId: ReadonlyMap<number, AnalysisSegment>,
    signal: AbortSignal,
  ) {
    const { frames, payload, req } = prebuilt;
    // Ce qui part est exactement ce qui est écrit dans requetes/ (sinon aucun appel).
    const file = toAbs(
      this.ctx.config.paths.storage,
      `${relDir}/requetes/${deepRequestName(w.rank)}`,
    );
    if ((await recordedHash(file)) !== requestHash(req)) {
      this.ctx.log.error(
        { runId: run.id, window: w.rank },
        'Requête Opus différente de celle enregistrée : aucun envoi',
      );
      return proposals.saveWindowResult(w.id, 'failed', []);
    }
    const res = await executor.execute({
      runId: run.id,
      windowId: w.id,
      chunkIndex: null,
      req,
      sentManifest: sentManifest(c.policy, payload.stats, frames),
      parse: (t) => parseModelJson(DeepResultSchema, t),
      signal,
      forceRecall: run.forceRecall,
      runRelDir: `analysis/${run.recordingId}/${run.id}`,
    });
    if (res.status === 'refused') return proposals.saveWindowResult(w.id, 'refused', []);
    if (res.status === 'truncated') return proposals.saveWindowResult(w.id, 'truncated', []);
    if (res.status !== 'ok') return proposals.saveWindowResult(w.id, 'failed', []);

    const clip = effectiveClipDuration(inp.creator, inp.game);
    const frameByLabel = new Map(frames.map((f) => [f.label, f]));
    const out: NewProposal[] = [];
    for (const m of res.value.moments) {
      const v = verifyMoment(m, {
        sentTexts: payload.sentTexts,
        segmentsById: byId,
        frameLabels: new Set(frameByLabel.keys()),
      });
      if (!v.ok) {
        this.ctx.log.info(
          { runId: run.id, window: w.rank, reason: v.reason },
          'Moment rejeté par la vérification',
        );
        continue;
      }
      const b = computeBoundaries({
        setup: v.value.setup,
        punchline: v.value.punchline,
        reactionEnd: v.value.reactionEnd,
        segments: c.segments,
        range: { startMs: w.farStartMs, endMs: w.endMs },
        clip,
      });
      const inClip = c.segments.filter((x) => x.endMs > b.startMs && x.startMs < b.endMs);
      const sigs = c.signals.filter((x) => x.endMs > b.startMs && x.startMs < b.endMs);
      const rel = computeReliability({
        verified: v.value,
        segmentsInClip: inClip,
        signalsInClip: sigs,
        policy: c.policy,
        segmentsById: byId,
      });
      const tier = decideTier({
        suggestedTier: m.suggestedTier,
        relevance: m.relevance,
        reliability: rel.score,
        flags: b.flags,
        minRelevance: this.cfg.minRelevance,
        minReliability: this.cfg.minReliability,
      });
      if (!tier) continue;
      out.push({
        id: randomUUID(),
        runId: run.id,
        recordingId: run.recordingId,
        windowId: w.id,
        callId: res.callId,
        tier,
        title: m.title,
        explanation: m.explanation,
        categories: m.categories,
        relevance: m.relevance,
        reliability: rel.score,
        reliabilityDetail: {
          components: rel.components,
          reasons: rel.reasons,
          issues: v.value.issues,
        },
        flags: b.flags,
        srcStartMs: b.startMs,
        srcEndMs: b.endMs,
        setupSegmentId: v.value.setup.id,
        punchlineSegmentId: v.value.punchline.id,
        reactionEndSegmentId: v.value.reactionEnd.id,
        punchlineMs: v.value.punchline.startMs,
        standalone: m.standalone,
        tracksUsed: m.tracksUsed,
        visual: v.value.visual,
        editingHint: m.editingHint,
        uncertainty: m.uncertainty,
        evidence: [
          ...v.value.evidence.map((e) => ({
            kind: 'quote' as const,
            segmentId: e.segmentId,
            quote: e.quote,
            verified: true,
            role: e.role,
            srcMs: e.srcMs,
            frameDerivativeId: null,
            note: null,
          })),
          ...v.value.visual.map((x) => ({
            kind: 'frame' as const,
            segmentId: null,
            quote: null,
            verified: true,
            role: null,
            srcMs: frameByLabel.get(x.frameLabel)?.atMs ?? null,
            frameDerivativeId: frameByLabel.get(x.frameLabel)?.derivativeId ?? null,
            note: x.note,
          })),
        ],
      });
    }
    proposals.saveWindowResult(w.id, 'analyzed', out);
  }

  private consolidate(runId: string, proposals: ProposalRepository) {
    const list = proposals.listProposals(runId, { includeMerged: true });
    const merged = consolidate(
      list.map((p) => ({
        id: p.id,
        tier: p.tier,
        relevance: p.relevance,
        reliability: p.reliability,
        startMs: p.srcStartMs,
        endMs: p.srcEndMs,
        punchlineMs: p.punchlineMs,
        punchlineQuote: p.evidence.find((e) => e.segmentId === p.punchlineSegmentId)?.quote ?? '',
      })),
    );
    proposals.applyConsolidation(runId, merged);
  }
}
