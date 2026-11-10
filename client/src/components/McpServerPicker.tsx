import { MCP_PHASE } from "../lib/domainPhase.ts";
import { Icon } from "../lib/icons/registry.ts";
import { STATUS_LABEL, asksFirstCount, endpointHost, needsReviewCount, orderServers } from "../lib/mcpView.ts";
import { ICON, STATUS } from "../lib/tokens.ts";
import { cn } from "../lib/utils.ts";
import type { AwaitedServer } from "../store/mcpStore.ts";
import type { McpServer } from "../types.ts";
import { EVAL_SELECT } from "./evalUi.tsx";
import { AlertTriangleIcon, ChevronDownIcon, ShieldAlertIcon } from "./panelIcons.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

export function McpServerFacts({ server }: { server: McpServer }) {
  const asking = asksFirstCount(server);
  const review = needsReviewCount(server);
  return (
    <>
      <StatusGlyph phase={MCP_PHASE[server.status]} size={ICON.xs} title={STATUS_LABEL[server.status]} />
      <span className="min-w-0 flex-1 truncate text-caption">{server.label}</span>
      <span className="shrink-0 text-tiny text-muted">{STATUS_LABEL[server.status]}</span>
      {asking > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-tiny tabular-nums"
          style={{ color: STATUS.warn }}
          title={asking === 1 ? "1 tool asks first" : `${asking} tools ask first`}
        >
          <ShieldAlertIcon size={ICON.badge} />
          {asking}
        </span>
      )}
      {review > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-tiny tabular-nums text-err"
          title={review === 1 ? "1 tool needs review" : `${review} tools need review`}
        >
          <AlertTriangleIcon size={ICON.badge} />
          {review}
        </span>
      )}
      <span className="shrink-0 text-tiny tabular-nums text-muted" title={server.tools.length === 1 ? "1 tool" : `${server.tools.length} tools`}>
        {server.tools.length}
      </span>
    </>
  );
}

export function McpServerPicker({
  servers,
  selected,
  pending,
  onSelect,
  onConnect,
}: {
  servers: readonly McpServer[];
  selected: McpServer | null;
  pending: AwaitedServer | null;
  onSelect: (serverId: string) => void;
  onConnect?: () => void;
}) {
  const status = selected?.status ?? "connecting";
  const name = selected?.label ?? (pending ? endpointHost(pending.endpoint) : "Choose a server");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-mcp-picker={selected?.id ?? pending?.id ?? ""}
          className={cn(EVAL_SELECT, "h-7 flex-1")}
          aria-label={`Server: ${name}, ${STATUS_LABEL[status]}. Choose another`}
          title={name}
        >
          {(selected || pending) && <StatusGlyph phase={MCP_PHASE[status]} size={ICON.xs} title={STATUS_LABEL[status]} />}
          <span className="min-w-0 flex-1 truncate text-left">{name}</span>
          {selected && <span className="shrink-0 text-tiny tabular-nums text-muted">{selected.tools.length}</span>}
          <ChevronDownIcon size={ICON.xs} className="shrink-0 text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent edge="strong" align="start" aria-label="Servers" className="max-h-[360px] w-[300px] overflow-y-auto">
        <DropdownMenuRadioGroup value={selected?.id ?? ""} onValueChange={onSelect}>
          {orderServers(servers).map((server) => (
            <DropdownMenuRadioItem key={server.id} value={server.id} title={server.label}>
              <McpServerFacts server={server} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onConnect && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem size="compact" onSelect={onConnect}>
              <Icon.mcp.connectServer size={ICON.xs} />
              Connect a server…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
