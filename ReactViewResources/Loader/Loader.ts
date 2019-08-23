﻿import * as Common from "./LoaderCommon";
import { Task, PluginsContext, View, mainFrameName } from "./LoaderCommon";

declare function define(name: string, dependencies: string[], definition: Function);

declare const CefSharp: {
    BindObjectAsync(settings: { NotifyIfAlreadyBound?: boolean, IgnoreCache: boolean }, objName: string): Promise<void>
    DeleteBoundObject(objName: string): boolean;
};

const reactLib: string = "React";
const reactDOMLib: string = "ReactDOM";
const viewsBundleName: string = "Views";
const pluginsBundleName: string = "Plugins";
const pluginsProviderModuleName: string = "PluginsProvider";

const [
    libsPath,
    enableDebugMode,
    modulesFunctionName,
    eventListenerObjectName,
    viewInitializedEventName,
    viewDestroyedEventName,
    viewLoadedEventName
] = Array.from(new URLSearchParams(location.search).keys());

const externalLibsPath = libsPath + "node_modules/";

const bootstrapTask = new Task();
const defaultStylesheetLoadTask = new Task();

let rootContext: React.Context<PluginsContext | null>;

function getModule(viewName: string, moduleName: string) {
    const view = Common.getView(viewName);
    if (!view) {
        throw new Error(`View "${viewName}" not loaded`);
    }
    const module = view.modules.get(moduleName);
    if (!module) {
        throw new Error(`Module "${moduleName}" not loaded in view "${viewName}"`);
    }
    return module;
}

window[modulesFunctionName] = getModule;

export async function showErrorMessage(msg: string): Promise<void> {
    const containerId = "webview_error";
    let msgContainer = document.getElementById(containerId) as HTMLDivElement;
    if (!msgContainer) {
        msgContainer = document.createElement("div");
        msgContainer.id = containerId;
        const style = msgContainer.style;
        style.backgroundColor = "#f45642";
        style.color = "white";
        style.fontFamily = "Arial";
        style.fontWeight = "bold";
        style.fontSize = "10px"
        style.padding = "3px";
        style.position = "absolute";
        style.top = "0";
        style.left = "0";
        style.right = "0";
        style.zIndex = "10000";
        style.height = "auto";
        style.wordWrap = "break-word";

        await waitForDOMReady();
        document.body.appendChild(msgContainer);
    }
    msgContainer.innerText = msg;
}

function importReact(): typeof React {
    return window[reactLib];
}

function importReactDOM(): typeof ReactDOM {
    return window[reactDOMLib];
}

function loadScript(scriptSrc: string, view: View): Promise<void> {
    const loadEventName = "load";
    return new Promise(async (resolve) => {
        const frameScripts = view.scriptsLoadTasks;

        // check if script was already added, fallback to main frame
        let scriptLoadTask = frameScripts.get(scriptSrc) || Common.getView(mainFrameName).scriptsLoadTasks.get(scriptSrc);
        if (scriptLoadTask) {
            // wait for script to be loaded
            await scriptLoadTask.promise;
            resolve();
            return;
        }

        const loadTask = new Task<void>();
        view.scriptsLoadTasks.set(scriptSrc, loadTask);

        const script = document.createElement("script");
        script.src = scriptSrc;
        script.addEventListener(loadEventName, () => {
            loadTask.setResult();
            resolve();
        });

        view.head.appendChild(script);
    });
}

function loadStyleSheet(stylesheet: string, containerElement: HTMLElement, markAsSticky: boolean): Promise<void> {
    return new Promise((resolve) => {
        const link = document.createElement("link");
        link.type = "text/css";
        link.rel = "stylesheet";
        link.href = stylesheet;
        link.addEventListener("load", () => resolve());
        if (markAsSticky) {
            link.dataset.sticky = "true";
        }
        containerElement.appendChild(link);
    });
}

export function loadDefaultStyleSheet(stylesheet: string): void {
    async function innerLoad() {
        try {
            await bootstrapTask.promise;
            await loadStyleSheet(stylesheet, document.head, true);

            defaultStylesheetLoadTask.setResult();
        } catch (error) {
            handleError(error);
        }
    }

    innerLoad();
}

export function loadPlugins(plugins: any[][], frameName: string): void {
    async function innerLoad() {
        try {
            await bootstrapTask.promise;

            const view = Common.getView(frameName);

            if (!view.isMain) {
                // wait for main frame plugins to be loaded, otherwise modules won't be loaded yet
                await Common.getView(mainFrameName).pluginsLoadTask.promise;
            }

            if (plugins && plugins.length > 0) {
                // load plugin modules
                const pluginsPromises = plugins.map(async m => {
                    const moduleName: string = m[0];
                    const mainJsSource: string = m[1];
                    const nativeObjectFullName: string = m[2]; // fullname with frame name included
                    const dependencySources: string[] = m[3];

                    if (view.isMain) {
                        // only load plugins sources once (in the main frame)
                        // load plugin dependency js sources
                        const dependencySourcesPromises = dependencySources.map(s => loadScript(s, view));
                        await Promise.all(dependencySourcesPromises);

                        // plugin main js source
                        await loadScript(mainJsSource, view);
                    }

                    const pluginsBundle = window[pluginsBundleName];
                    const module = (pluginsBundle ? pluginsBundle[moduleName] : null) || window[viewsBundleName][moduleName];
                    if (!module || !module.default) {
                        throw new Error(`Failed to load '${moduleName}' (might not be a module with a default export)`);
                    }

                    const pluginNativeObject = await bindNativeObject(nativeObjectFullName, view);

                    view.modules.set(moduleName, new module.default(pluginNativeObject));
                });

                await Promise.all(pluginsPromises);
            }

            view.pluginsLoadTask.setResult();
        } catch (error) {
            handleError(error);
        }
    }

    innerLoad();
}

export function loadComponent(
    componentName: string,
    componentNativeObjectName: string,
    componentSource: string,
    dependencySources: string[],
    cssSources: string[],
    maxPreRenderedCacheEntries: number,
    hasStyleSheet: boolean,
    hasPlugins: boolean,
    componentNativeObject: any,
    frameName: string,
    componentHash: string): void {

    function getComponentCacheKey(propertiesHash: string) {
        return componentSource + "|" + propertiesHash;
    }

    async function innerLoad() {
        try {
            if (hasStyleSheet) {
                // wait for the stylesheet to load before first render
                await defaultStylesheetLoadTask.promise;
            }

            const view = Common.getView(frameName);
            const rootElement = view.root;

            const componentCacheKey = getComponentCacheKey(componentHash);
            const enableHtmlCache = view.isMain; // disable cache retrieval for inner views, since react does not currently support portals hydration
            const cachedElementHtml = enableHtmlCache ? localStorage.getItem(componentCacheKey) : null; 
            if (cachedElementHtml) {
                // render cached component html to reduce time to first render
                rootElement.innerHTML = cachedElementHtml;
                await waitForNextPaint();
            }

            const promisesToWaitFor = [bootstrapTask.promise];
            if (hasPlugins) {
                promisesToWaitFor.push(view.pluginsLoadTask.promise);
            }
            await Promise.all(promisesToWaitFor);

            // load component dependencies js sources and css sources
            const dependencyLoadPromises =
                dependencySources.map(s => loadScript(s, view)).concat(
                    cssSources.map(s => loadStyleSheet(s, view.head, false)));
            await Promise.all(dependencyLoadPromises);

            // main component script should be the last to be loaded, otherwise errors might occur
            await loadScript(componentSource, view);

            const Component = window[viewsBundleName][componentName].default;
            const React = importReact();

            // create proxy for properties obj to delay its methods execution until native object is ready
            const properties = createPropertiesProxy(componentNativeObject, componentNativeObjectName, view);
            
            Component.contextType = rootContext;

            const context = new PluginsContext(Array.from(view.modules.values()));
                
            const viewComponent = React.createElement(Component, { ref: e => view.modules.set(componentName, e), ...properties });
            const root = React.createElement(rootContext.Provider, { value: context }, viewComponent);

            await view.renderContent(root);

            await waitForNextPaint();

            if (enableHtmlCache && !cachedElementHtml && maxPreRenderedCacheEntries > 0) {
                // cache view html for further use
                const elementHtml = rootElement.innerHTML;
                // get all stylesheets except the stick ones (which will be loaded by the time the html gets rendered) otherwise we could be loading them twice
                const stylesheets = Common.getStylesheets(view.head).filter(l => l.dataset.sticky !== "true").map(l => l.outerHTML).join("");

                localStorage.setItem(componentCacheKey, stylesheets + elementHtml); // insert html into the cache

                const componentCachedInfo = localStorage.getItem(componentSource);
                const cachedEntries: string[] = componentCachedInfo ? JSON.parse(componentCachedInfo) : [];

                // remove cached entries that are older tomantina cache size within limits
                while (cachedEntries.length >= maxPreRenderedCacheEntries) {
                    const olderCacheEntryKey = cachedEntries.shift() as string;
                    localStorage.removeItem(getComponentCacheKey(olderCacheEntryKey));
                }

                cachedEntries.push(componentHash);
                localStorage.setItem(componentSource, JSON.stringify(cachedEntries));
            }

            window.dispatchEvent(new Event('viewready'));

            fireNativeNotification(viewLoadedEventName, frameName);
        } catch (error) {
            handleError(error);
        }
    }

    innerLoad();
}

async function bootstrap() {
    // prevent browser from loading the dropped file
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());

    await waitForDOMReady();

    const rootElement = document.getElementById(Common.webViewRootId) as HTMLElement;

    function renderMainView(children: React.ReactElement): Promise<void> {
        const ReactDOM = importReactDOM();
        return new Promise<void>(resolve => ReactDOM.hydrate(children, rootElement, resolve));
    }

    // add main view
    Common.addView(mainFrameName, true, rootElement, document.head, renderMainView);

    Common.addViewAddedEventListener(view => fireNativeNotification(viewInitializedEventName, view.name));
    Common.addViewRemovedEventListener(view => {
        // delete native objects
        view.nativeObjectNames.forEach(nativeObjecName => CefSharp.DeleteBoundObject(nativeObjecName));

        fireNativeNotification(viewDestroyedEventName, view.name);
    });

    await loadFramework();

    // bind event listener object ahead-of-time
    await CefSharp.BindObjectAsync({ IgnoreCache: false }, eventListenerObjectName);

    bootstrapTask.setResult();
}

async function loadFramework(): Promise<void> {
    const view = Common.getView(mainFrameName);
    await loadScript(externalLibsPath + "prop-types/prop-types.min.js", view); /* Prop-Types */
    await loadScript(externalLibsPath + "react/umd/react.production.min.js", view); /* React */
    await loadScript(externalLibsPath + "react-dom/umd/react-dom.production.min.js", view); /* ReactDOM */

    define("react", [], () => importReact());
    define("react-dom", [], () => importReactDOM());

    // create context
    rootContext = React.createContext<PluginsContext | null>(null);
    window[pluginsProviderModuleName] = { PluginsContext: rootContext };
}

function createPropertiesProxy(basePropertiesObj: {}, nativeObjName: string, view: View): {} {
    const proxy = Object.assign({}, basePropertiesObj);
    Object.keys(proxy).forEach(key => {
        const value = basePropertiesObj[key];
        if (value !== undefined) {
            proxy[key] = value;
        } else {
            proxy[key] = async function () {
                let nativeObject = window[nativeObjName];
                if (!nativeObject) {
                    nativeObject = await new Promise(async (resolve) => {
                        await waitForNextPaint();
                        const nativeObject = await bindNativeObject(nativeObjName, view);
                        resolve(nativeObject);
                    });
                }
                return nativeObject[key].apply(window, arguments);
            };
        }
    });
    return proxy;
}

async function bindNativeObject(nativeObjectName: string, view: View) {
    await CefSharp.BindObjectAsync({ IgnoreCache: false }, nativeObjectName);

    // add to the native objects collection
    view.nativeObjectNames.push(nativeObjectName);

    return window[nativeObjectName];
}

function handleError(error: Error) {
    if (enableDebugMode) {
        showErrorMessage(error.message);
    }
    throw error;
}

function waitForNextPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            setTimeout(resolve);
        });
    });
}

function waitForDOMReady() {
    if (document.readyState === "loading") {
        return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
    return Promise.resolve();
}

function fireNativeNotification(eventName: string, ...args: string[]) {
    window[eventListenerObjectName].notify(eventName, ...args);
}

bootstrap();