export {
  KnowledgeService,
  KnowledgeError,
  KnowledgeDeniedError,
  type IntakeCandidateInput,
  type CandidateView,
  type DecisionCommand,
  type ConfirmResult,
} from "./service.ts";
export type {
  KnowledgeStorePort,
  CandidateConfidence,
  CandidateStatus,
  FactScope,
  KnowledgeActor,
  KnowledgeActorKind,
  KnowledgeCandidate,
  KnowledgeRevision,
  ConfirmedFact,
  KnowledgeDecision,
  DecisionKind,
  DecisionOutcome,
  OffersKnowledgeSnapshot,
} from "./types.ts";
