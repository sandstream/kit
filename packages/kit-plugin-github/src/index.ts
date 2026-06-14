export {
  makeClient,
  listRepoSecrets,
  createOrUpdateRepoSecret,
  deleteRepoSecret,
  listDeployKeys,
  type MgmtClient,
  type MgmtClientConfig,
  type RepoSecretSummary,
  type RepoPublicKey,
  type DeployKey,
} from "./mgmt-api.js";
