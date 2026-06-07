import type { RouteObject } from "react-router-dom";

import { DeploymentDetailPage } from "./DeploymentDetailPage";

export const deploymentRoutes: RouteObject[] = [
  {
    path: "deployments/:deploymentId",
    element: <DeploymentDetailPage />
  }
];
