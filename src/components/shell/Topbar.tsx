import { useLocation } from "react-router-dom";

function visibleSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function routeLabel(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).map(visibleSegment);

  if (parts.length === 1 && parts[0] === "projects") {
    return "Projects / Yard inventory";
  }

  if (parts[0] === "deployments" && parts[1]) {
    return `Deployments / ${parts[1]} / Consist ticket`;
  }

  if (parts[0] === "projects" && parts[1]) {
    if (parts[2] === "release" && parts[3]) {
      return `Projects / ${parts[1]} / Promotion gate / ${parts[3]}`;
    }
    if (parts[2] === "rollback" && parts[3]) {
      return `Projects / ${parts[1]} / Rollback gate / ${parts[3]}`;
    }
    return `Projects / ${parts[1]} / Project board`;
  }

  return "Projects / Yard inventory";
}

export function Topbar() {
  const location = useLocation();

  return (
    <header className="topbar" aria-label="Current console location">
      <div className="topbar__title">
        <span className="eyebrow">SiteFlow operator console</span>
        <span className="topbar__heading" aria-current="page">
          {routeLabel(location.pathname)}
        </span>
      </div>
    </header>
  );
}
