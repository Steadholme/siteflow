export function deploymentEnvironmentForBranch(branch, productionBranch) {
    return branch && productionBranch && branch === productionBranch ? "production" : "preview";
}
