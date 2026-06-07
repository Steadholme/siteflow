import { Navigate, createBrowserRouter } from "react-router-dom";

import { AppShell } from "@components/shell/AppShell";
import { deploymentRoutes } from "@features/deployments/deploymentRoutes";
import { projectRoutes } from "@features/projects/projectRoutes";
import { releaseRoutes } from "@features/release/releaseRoutes";

export const appRoutePaths = {
  projects: "/projects",
  projectDetail: "/projects/:projectId",
  deploymentDetail: "/deployments/:deploymentId",
  release: "/projects/:projectId/release/:channel",
  rollback: "/projects/:projectId/rollback/:channel"
} as const;

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to={appRoutePaths.projects} replace /> },
      ...projectRoutes,
      ...deploymentRoutes,
      ...releaseRoutes,
      { path: "*", element: <Navigate to={appRoutePaths.projects} replace /> }
    ]
  }
]);
