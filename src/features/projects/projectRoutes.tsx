import type { RouteObject } from "react-router-dom";

import { ProjectDetailPage } from "./ProjectDetailPage";
import { ProjectListPage } from "./ProjectListPage";
import "./projects.css";

export const projectRoutes: RouteObject[] = [
  {
    path: "projects",
    element: <ProjectListPage />
  },
  {
    path: "projects/:projectId",
    element: <ProjectDetailPage />
  }
];
