// Pelare 3 — exec-broker: public barrel. Callers import from
// "exec-broker/index.js".

export { checkEgress, checkFsWrite, scopeEnv, type BrokerDecision } from "./decisions.js";

export {
  loadBrokerPolicy,
  brokerPolicyPath,
  BROKER_POLICY_ENV,
  DEFAULT_BROKER_POLICY_FILE,
  type BrokerPolicy,
} from "./policy.js";

export { brokerExec, runBrokered, type BrokerContext, type BrokerOutcome } from "./broker.js";
