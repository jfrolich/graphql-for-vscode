'use strict';

import * as sysPath from 'path';
import {
  ExtensionContext,
  window,
  workspace as Workspace,
  WorkspaceFolder,
} from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient';

import { findConfigFile as findGQLConfigFile } from '@playlyfe/gql-language-server';
import ClientStatusBarItem from './ClientStatusBarItem';
import { isExtensionRunningLocally } from './utils';

const EXT_NAME = 'graphqlForVSCode';
const GQL_LANGUAGE_SERVER_CLI_PATH = require.resolve(
  '@playlyfe/gql-language-server/lib/bin/cli',
);

interface IClient {
  dispose: () => any;
  statusBarItem: ClientStatusBarItem;
  client: LanguageClient;
}

const clients: Map<string, IClient | null> = new Map();

export function activate(context: ExtensionContext) {
  createClientForWorkspaces(context);
  // update clients when workspaceFolderChanges
  Workspace.onDidChangeWorkspaceFolders(() => {
    createClientForWorkspaces(context);
  });
}

export function deactivate(): Thenable<void> {
  const promises: Array<Thenable<void>> = [];
  clients.forEach(client => {
    if (client) {
      promises.push(client.dispose());
    }
  });
  return Promise.all(promises).then(() => undefined);
}

function createClientForWorkspaces(context: ExtensionContext) {
  const workspaceFolders = Workspace.workspaceFolders || [];
  const workspaceFoldersIndex: { [key: string]: boolean } = {};

  workspaceFolders.forEach(folder => {
    const key = folder.uri.toString();
    if (!clients.has(key)) {
      const client = createClientForWorkspace(folder, context);
      // console.log('adding client', key, client);
      clients.set(key, client);
    }
    workspaceFoldersIndex[key] = true;
  });

  // remove clients for removed workspace folders
  clients.forEach((client, key) => {
    // remove client
    if (!workspaceFoldersIndex[key]) {
      // console.log('deleting client', key);
      clients.delete(key);
      if (client) {
        client.dispose();
      }
    }
  });
}

function createClientForWorkspace(
  folder: WorkspaceFolder,
  context: ExtensionContext,
): null | IClient {
  // per workspacefolder settings
  const config = Workspace.getConfiguration(EXT_NAME, folder.uri);
  const outputChannel = window.createOutputChannel(`GraphQL - ${folder.name}`);
  // TODO: make it configurable
  const gqlconfigDir = resolvePath('.', folder);
  const runtime = config.get<string | undefined>('runtime', undefined);

  // check can activate gql plugin
  // if config found in folder then activate
  try {
    findGQLConfigFile(gqlconfigDir);
  } catch (err) {
    outputChannel.appendLine(
      `Not activating language-server for workspace folder '${folder.name}'.\n` +
        `Reason: ${err.message}`,
    );
    return null;
  }

  const gqlLanguageServerCliOptions = [
    `--config-dir=${gqlconfigDir}`,
    `--gql-path=${resolvePath(config.get('nodePath', '.'), folder)}`,
    `--loglevel=${config.get('loglevel')}`,
    '--watchman=true',
    '--auto-download-gql=false',
  ];

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: {
      runtime,
      module: GQL_LANGUAGE_SERVER_CLI_PATH,
      transport: TransportKind.ipc,
      args: gqlLanguageServerCliOptions,
    },
    debug: {
      runtime,
      module: GQL_LANGUAGE_SERVER_CLI_PATH,
      transport: TransportKind.ipc,
      args: gqlLanguageServerCliOptions,
      options: {
        execArgv: ['--nolazy', '--inspect=6008'],
      },
    },
  };

  // TEMP_FIX: relativePattern is not working when extension is
  // running using vscode-remote with `local os = windows`
  // NOTE: relativePattern is used only for optimization so it will
  // not change the extension behaviour
  const canUseRelativePattern = isExtensionRunningLocally(context);

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    diagnosticCollectionName: 'graphql',
    initializationFailedHandler: error => {
      window.showErrorMessage(
        `Plugin 'graphql-for-vscode' couldn't start for workspace '${folder.name}'. See output channel '${folder.name}' for more details.`,
      );
      client.error('Server initialization failed:', error.message);
      client.outputChannel.show(true);
      // avoid retries
      return false;
    },
    outputChannel,
    workspaceFolder: folder,
    initializationOptions: {
      relativePattern: canUseRelativePattern,
    },
  };

  // Create the language client and start the client.
  const client = new LanguageClient(
    EXT_NAME,
    'Graphql For VSCode',
    serverOptions,
    clientOptions,
  );

  const statusBarItem = new ClientStatusBarItem(client, canUseRelativePattern);

  const subscriptions = [
    client.start(),
    {
      dispose() {
        outputChannel.hide();
        outputChannel.dispose();
      },
    },
    statusBarItem,
  ];

  return {
    dispose: () => {
      subscriptions.forEach(subscription => {
        subscription.dispose();
      });
    },
    statusBarItem,
    client,
  };
}

function resolvePath(path: string, folder: WorkspaceFolder): string {
  if (sysPath.isAbsolute(path)) {
    return path;
  }

  // resolve with respect to workspace folder
  return sysPath.join(folder.uri.fsPath, path);
}
