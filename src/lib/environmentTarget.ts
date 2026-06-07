export function deploymentEnvironmentForBranch(branch: string | undefined, productionBranch: string | undefined) {
  return branch && productionBranch && branch === productionBranch ? "production" : "preview";
}
