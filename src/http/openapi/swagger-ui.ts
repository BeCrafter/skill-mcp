// P0-2 — Swagger UI is loaded from a public CDN to avoid pulling the entire
// `swagger-ui-dist` package (~3 MB) into the runtime bundle. The CDN URL is
// pinned to a major version so a transitive Swagger UI breaking change can't
// silently break our docs page.
const SWAGGER_UI_VERSION = "5.17.14";

export function renderSwaggerUiHtml(specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Skill MCP API — Swagger UI</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css">
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: "#swagger-ui",
        deepLinking: true,
        persistAuthorization: true,
      });
    };
  </script>
</body>
</html>
`;
}
