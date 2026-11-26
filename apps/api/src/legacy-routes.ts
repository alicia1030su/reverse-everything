import type { FastifyInstance } from 'fastify';
import { findFreeAlternatives } from '@reverse/legacy-revival';
import type { Database } from '@reverse/workflow';
import { AppError } from '@reverse/contracts';

export function registerLegacyRoutes(app:FastifyInstance,options:{db:Database;dataDir:string}):void{
  app.get('/api/legacy/alternatives',async request=>{
    const query=request.query as {category?:unknown;q?:unknown};
    const category=typeof query.category==='string'?query.category:undefined;
    if(category&&!['image-viewer','audio-player','archiver','text-editor'].includes(category))throw new AppError('BAD_REQUEST','Invalid alternative category',400);
    const q=typeof query.q==='string'?query.q.slice(0,120):'';
    return {items:findFreeAlternatives(category,q),sourcePolicy:'Official project websites and licenses only; no piracy or crack sites.'};
  });
  app.get('/api/legacy/privacy',async()=>{
    const settings=options.db.settings();
    const validRemoteAi=options.db.raw.prepare("SELECT 1 FROM authorization_scopes WHERE remote_ai_allowed=1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1").get(new Date().toISOString());
    return {
      localOnlyAnalysis:true,
      remoteAiEnabled:settings.ai_enabled==='true',
      remoteAiAllowed:Boolean(validRemoteAi),
      remoteAiEndpointConfigured:Boolean(settings.ai_base_url),
      remoteAiPolicy:'Each task also requires an unexpired, unrevoked project authorization for its exact target and adapter with network-access permission.',
      dataDir:options.dataDir,
      networkSteps:['Optional remote AI only after explicit project authorization','Optional user-confirmed browser download','Optional user-installed Wine/DOSBox/VM or official runtimes'],
      localArtifacts:['SQLite database and encrypted settings','Task evidence, logs and generated artifacts','Local model traffic stays on loopback'],
      controls:['Remote AI is disabled by default','API keys are encrypted at rest','Unknown programs are never executed by the legacy adapter','External dependencies are not installed automatically'],
      limitations:['Third-party tools may have their own network behavior','This is not a guarantee that all third-party software is network-silent'],
    };
  });
}
