window.__ModuleLoader__.load({
  id: "dsh-plugin-updater",
  factory: (require) => {
    const { createElement: h, useLayoutEffect, useMemo, useState, useSyncExternalStore } = require("react");
    const { createPortal } = require("react-dom");
    const { Button, IconRefreshOutlineRegular, StateDot } = require("@deepseek-ai/dsh-client-ui-primitives");
    const PANEL = "[data-plugin-panel]";
    const GROUP = '[data-plugin-group="bundles"]';
    const PACKAGE = "[data-plugin-package]";

    function useTargets() {
      const [targets, setTargets] = useState([]);
      useLayoutEffect(() => {
        let panel;
        let frame;
        function read() {
          frame = undefined;
          panel = document.querySelector(PANEL);
          const group = panel?.querySelector(GROUP);
          const heading = group?.querySelector(':scope > [class$="_groupHead"]');
          const next = heading ? [heading, ...group.querySelectorAll(`${PACKAGE} > div > [class$="_cardEnd"]`)] : [];
          setTargets((previous) => previous.length === next.length
            && previous.every((element, index) => element === next[index]) ? previous : next);
        }
        // DSH 0.2.2-rc.1 has no list action slots. Use portals into the existing
        // list and rediscover their containers when DSH changes tabs or views.
        const observer = new MutationObserver((records) => {
          if (frame !== undefined) return;
          if (!panel?.isConnected || records.some(({ target }) => panel.contains(target))) {
            frame = requestAnimationFrame(read);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        read();
        return () => {
          observer.disconnect();
          if (frame !== undefined) cancelAnimationFrame(frame);
        };
      }, []);
      return targets;
    }

    function apply(ctx) {
      const t = ctx.locale.bind("pluginManager");
      const subscribeLocale = (fn) => ctx.locale.subscribe(fn);
      const getLanguage = () => ctx.locale.getSnapshot().active;
      const subscribePanel = (fn) => ctx.layout.panelInfo.subscribe(fn);
      const getPanel = () => ctx.layout.panelInfo.getSnapshot().activePanelId;
      const subscribeEntry = (fn) => ctx.slots.subscribe("main", fn);
      const getEntry = () => ctx.slots.entries("main").find(({ options }) => options.key === "plugins");

      function Actions({ face }) {
        const { packages, versions, refreshStatus, busy, install, update, confirm } =
          useSyncExternalStore(face.hooks.pluginManager.subscribe, face.hooks.pluginManager.getSnapshot);
        const language = useSyncExternalStore(subscribeLocale, getLanguage);
        const [heading, ...rows] = useTargets();
        if (!heading) return null;

        const refreshing = refreshStatus === "refreshing";
        const managing = update !== null || install.open || install.requestId !== undefined || confirm !== null;
        const hasUpdatable = packages.some((pkg) => pkg.updatable);
        const checkLabel = language === "zh" ? "检查更新" : "Check for updates";
        const check = createPortal(h(Button, {
          variant: "outline",
          size: "sm",
          disabled: !hasUpdatable || refreshing || managing,
          "aria-busy": refreshing,
          icon: refreshing ? h(StateDot, { state: "ongoing", size: 13 }) : h(IconRefreshOutlineRegular, { size: 13 }),
          onClick: face.refresh,
          children: refreshing ? t("versionsChecking") : checkLabel,
        }), heading, "check");

        return [check, ...rows.map((container) => {
          const name = container.closest(PACKAGE)?.getAttribute("data-plugin-package");
          const pkg = packages.find((item) => item.name === name);
          const list = versions[name]?.list;
          if (!pkg?.updatable || list?.status !== "listed" || list.installed !== pkg.version) return null;
          const candidate = list.versions.find((version) => version.bundle && version.incompatible === undefined
            && version.deprecated === undefined && !version.prerelease);
          if (!candidate) return null;

          const label = t("versionsUpdateLabel", { version: candidate.version });
          return createPortal(h(Button, {
            variant: "ghost",
            size: "sm",
            style: { order: -1, whiteSpace: "nowrap" },
            title: label,
            "aria-label": `${name} · ${label}`,
            disabled: refreshing || managing || busy.includes(name),
            onClick: () => face.openUpdate(name, candidate.version),
            children: t("update"),
          }), container, name);
        })];
      }

      function PluginOverlay() {
        const panel = useSyncExternalStore(subscribePanel, getPanel);
        const entry = useSyncExternalStore(subscribeEntry, getEntry);
        // Read the native page's injected store and actions without replacing its registration.
        const face = useMemo(() => entry?.inject?.(), [entry]);
        if (panel !== "plugins" || !face?.hooks?.pluginManager || !face.refresh || !face.openUpdate) return null;
        return h(Actions, { face });
      }

      ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-plugin-updater",
      }, PluginOverlay)), "dsh-plugin-updater: installed list actions");
    }

    return { apply, inject: ["slots", "layout", "locale"] };
  },
});
