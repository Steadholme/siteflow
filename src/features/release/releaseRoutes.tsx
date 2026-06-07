import type { RouteObject } from "react-router-dom";

import { ReleaseConsolePage } from "./ReleaseConsolePage";
import { RollbackConsolePage } from "./RollbackConsolePage";
import "./release.css";

export const releaseRoutes: RouteObject[] = [
  {
    path: "projects/:projectId/release/:channel",
    element: <ReleaseConsolePage />
  },
  {
    path: "projects/:projectId/rollback/:channel",
    element: <RollbackConsolePage />
  }
];
