import path from 'node:path';
import ConfigurationChief from './configuration-chief.js';
import { ROOT_WORKSPACE_NAME } from './constants.js';
import DependencyDeputy from './dependency-deputy.js';
import IssueCollector from './issue-collector.js';
import ProjectPrincipal from './project-principal.js';
import SourceLab from './source-lab.js';
import { compact } from './util/array.js';
import { debugLogObject, debugLogFiles } from './util/debug.js';
import { _findExternalImportModuleSpecifiers } from './util/externalImports.js';
import { findFile, loadJSON } from './util/fs.js';
import { _glob } from './util/glob.js';
import { _findDuplicateExportedNames } from './util/project.js';
import { loadTSConfig } from './util/tsconfig-loader.js';
import WorkspaceWorker from './workspace-worker.js';
import type { CommandLineOptions } from './types/cli.js';
import type { Report } from './types/issues.js';

export const main = async (unresolvedConfiguration: CommandLineOptions) => {
  const { cwd, tsConfigFile, gitignore, isStrict, isProduction, isShowProgress } = unresolvedConfiguration;

  const chief = new ConfigurationChief({ cwd, isStrict, isProduction });
  const deputy = new DependencyDeputy();

  debugLogObject('Unresolved configuration', unresolvedConfiguration);

  const collector = new IssueCollector({ cwd, isShowProgress });
  collector.updateMessage('Reading configuration and manifest files...');

  await chief.loadLocalConfig();

  const workspaces = await chief.getActiveWorkspaces();

  const negatedWorkspacePatterns = await chief.getNegatedWorkspacePatterns();

  debugLogObject('Included workspaces', workspaces);

  const report = chief.resolveIncludedIssueTypes();

  const workspaceDirs = Object.values(workspaces)
    .map(workspace => workspace.dir)
    .sort((a, b) => b.length - a.length);

  const lab = new SourceLab({ report, workspaceDirs });

  const principal = new ProjectPrincipal();

  for (const { name, dir, config, ancestors } of workspaces) {
    const isRoot = name === ROOT_WORKSPACE_NAME;

    const suffix = isRoot ? '' : ` (${name})`;

    const manifestPath = isRoot ? chief.manifestPath : await findFile(dir, 'package.json');
    const manifest = isRoot ? chief.manifest : manifestPath && (await loadJSON(manifestPath));

    if (!manifestPath || !manifest) continue;

    deputy.addWorkspace({ name, dir, manifestPath, manifest });

    const tsConfigFilePath = path.join(dir, tsConfigFile ?? 'tsconfig.json');
    const tsConfig = await loadTSConfig(tsConfigFilePath);

    if (isRoot && tsConfig) {
      principal.tsConfigFilePath = tsConfigFilePath;
    }

    if (tsConfig?.compilerOptions?.paths) {
      deputy.addTypeScriptConfigPathGlobs(name, tsConfig.compilerOptions.paths);
      principal.addTypeScriptPaths(dir, tsConfig.compilerOptions.paths);
    }

    collector.updateMessage(`Resolving custom dependencies...${suffix}`);

    const workspaceManifest = deputy.getWorkspaceManifest(name);

    if (!workspaceManifest) continue;

    const worker = new WorkspaceWorker({
      name,
      dir,
      config,
      rootWorkspaceConfig: chief.getConfigForWorkspace(ROOT_WORKSPACE_NAME),
      manifest,
      ancestorManifests: ancestors.map(name => deputy.getManifest(name)),
      rootConfig: chief.config,
      negatedWorkspacePatterns,
      rootWorkspaceDir: cwd,
      isProduction,
      isStrict,
    });

    await worker.init();

    // Add listed peer dependencies, as they're often not referenced anywhere, used to settle dependencies at the end
    deputy.addPeerDependencies(name, worker.peerDependencies);

    // Add installed binaries
    deputy.setInstalledBinaries(name, worker.installedBinaries);

    if (config?.entry && config?.project) {
      /**
       * Production mode:
       * - Resolve entry files
       * - Resolve project files
       * - Resolve production plugin entry files
       *
       * Non-production mode:
       * - Resolve entry files
       * - Resolve project files
       * - Resolve plugin entry files
       * - Resolve plugin project files
       * - Resolve plugin configuration files
       */
      if (isProduction) {
        collector.updateMessage(`Resolving entry files${suffix}...`);
        const workspaceEntryPaths = await _glob({
          cwd,
          workingDir: dir,
          patterns: worker.getProductionEntryFilePatterns(),
          ignore: worker.getWorkspaceIgnorePatterns(),
          gitignore,
        });
        debugLogFiles(`Globbed entry paths${suffix}`, workspaceEntryPaths);
        workspaceEntryPaths.forEach(entryPath => principal.addEntryPath(entryPath));

        collector.updateMessage(`Resolving production plugin entry files${suffix}...`);
        const pluginWorkspaceEntryPaths = await _glob({
          cwd,
          workingDir: dir,
          patterns: worker.getProductionPluginEntryFilePatterns(),
          ignore: worker.getWorkspaceIgnorePatterns(),
          gitignore,
        });
        debugLogFiles(`Globbed production plugin entry paths${suffix}`, pluginWorkspaceEntryPaths);
        pluginWorkspaceEntryPaths.forEach(entryPath => principal.addEntryPath(entryPath));
        pluginWorkspaceEntryPaths.forEach(entryPath => lab.skipExportsAnalysisFor(entryPath));

        if (workspaceEntryPaths.length > 0 || pluginWorkspaceEntryPaths.length > 0) {
          collector.updateMessage(`Resolving project files${suffix}...`);
          const workspaceProjectPaths = await _glob({
            cwd,
            workingDir: dir,
            patterns: worker.getProductionProjectFilePatterns(),
            ignore: worker.getWorkspaceIgnorePatterns(),
            gitignore,
          });
          debugLogFiles(`Globbed project paths${suffix}`, workspaceProjectPaths);
          workspaceProjectPaths.forEach(projectPath => principal.addProjectPath(projectPath));
        }

        // Without source files, better cancel the workspace for dependency settling
        if (workspaceEntryPaths.length === 0 && pluginWorkspaceEntryPaths.length === 0) {
          deputy.cancelWorkspace(name);
        }
      } else {
        {
          collector.updateMessage(`Resolving entry files${suffix}...`);

          const workspaceEntryPaths = await _glob({
            cwd,
            workingDir: dir,
            patterns: worker.getEntryFilePatterns(),
            ignore: worker.getWorkspaceIgnorePatterns(),
            gitignore,
          });
          debugLogFiles(`Globbed entry paths${suffix}`, workspaceEntryPaths);
          workspaceEntryPaths.forEach(entryPath => principal.addEntryPath(entryPath));
        }

        {
          collector.updateMessage(`Resolving project files${suffix}...`);

          const workspaceProjectPaths = await _glob({
            cwd,
            workingDir: dir,
            patterns: worker.getProjectFilePatterns(),
            ignore: worker.getWorkspaceIgnorePatterns(),
            gitignore,
          });
          debugLogFiles(`Globbed project paths${suffix}`, workspaceProjectPaths);
          workspaceProjectPaths.forEach(projectPath => principal.addProjectPath(projectPath));
        }

        {
          collector.updateMessage(`Resolving plugin entry files${suffix}...`);

          const pluginWorkspaceEntryPaths = await _glob({
            cwd,
            workingDir: dir,
            patterns: worker.getPluginEntryFilePatterns(),
            ignore: worker.getWorkspaceIgnorePatterns(),
            gitignore,
          });
          debugLogFiles(`Globbed plugin entry paths${suffix}`, pluginWorkspaceEntryPaths);
          pluginWorkspaceEntryPaths.forEach(entryPath => principal.addEntryPath(entryPath));
          pluginWorkspaceEntryPaths.forEach(entryPath => lab.skipExportsAnalysisFor(entryPath));
        }

        {
          collector.updateMessage(`Resolving plugin project files${suffix}...`);

          const pluginWorkspaceProjectPaths = await _glob({
            cwd,
            workingDir: dir,
            patterns: worker.getPluginProjectFilePatterns(),
            ignore: worker.getWorkspaceIgnorePatterns(),
            gitignore,
          });
          debugLogFiles(`Globbed plugin project paths${suffix}`, pluginWorkspaceProjectPaths);
          pluginWorkspaceProjectPaths.forEach(projectPath => principal.addProjectPath(projectPath));
          pluginWorkspaceProjectPaths.forEach(entryPath => lab.skipExportsAnalysisFor(entryPath));
        }

        {
          collector.updateMessage(`Resolving plugin configuration files${suffix}...`);
          const configurationEntryPaths = await _glob({
            cwd,
            workingDir: dir,
            patterns: compact(worker.getPluginConfigPatterns()),
            ignore: worker.getWorkspaceIgnorePatterns(),
            gitignore,
          });
          debugLogFiles(`Globbed plugin configuration paths${suffix}`, configurationEntryPaths);

          configurationEntryPaths.forEach(entryPath => principal.addEntryPath(entryPath));
          configurationEntryPaths.forEach(entryPath => principal.addProjectPath(entryPath));
          configurationEntryPaths.forEach(entryPath => lab.skipExportsAnalysisFor(entryPath));
        }
      }

      if (report.dependencies || report.unlisted || report.files) {
        const workspaceDependencies = deputy.getAllDependencies(name);
        const { referencedDependencyIssues, referencedDependencies } = await worker.findDependenciesByPlugins();

        // Add referenced dependencies to settle them at the end
        for (const packageName of workspaceDependencies) {
          if (referencedDependencies.has(packageName)) {
            deputy.addReferencedDependency(name, packageName);
          }
        }

        for (const issue of referencedDependencyIssues) {
          // Referenced files "block" the `addFilesIssues` we'll do later on
          if (issue.symbol.startsWith('/')) {
            collector.referencedFiles.add(issue.symbol);
          } else {
            issue.symbol = deputy.resolvePackageName(issue.symbol);

            // Skip direct and internal dependencies
            if (deputy.isInternalDependency(name, issue.symbol)) continue;
            if (workspaceDependencies.includes(issue.symbol)) continue;

            if (!isStrict && !isRoot) {
              // Skip dependencies that are listed in root workspace
              // TODO Look up all ancestors
              const rootDependencies = deputy.getAllDependencies(ROOT_WORKSPACE_NAME);
              if (rootDependencies.includes(issue.symbol)) {
                continue;
              }

              // Skip binaries that are installed in root workspace
              // TODO Look up all ancestors
              const rootBinaries = deputy.getInstalledBinaries(ROOT_WORKSPACE_NAME);
              if (rootBinaries?.has(issue.symbol)) {
                // Also, mark the binary's dependencies of the root workspace as referenced
                const dependencies = rootBinaries.get(issue.symbol);
                dependencies?.forEach(dependency => deputy.addReferencedDependency(ROOT_WORKSPACE_NAME, dependency));
                continue;
              }
            }

            // Unlisted referenced dependencies can be marked as an issue, right away (for instant progress output)
            collector.addIssue(issue);
          }
        }
      }
    }
  }

  collector.setReport(report);

  const { usedProductionFiles, unreferencedProductionFiles } = principal.settleFiles();

  collector.setProjectFilesCount(unreferencedProductionFiles.size + usedProductionFiles.length);

  collector.addFilesIssues(unreferencedProductionFiles);

  collector.updateMessage('Connecting the dots...');

  usedProductionFiles.forEach(sourceFile => {
    collector.counters.processed++;
    const filePath = sourceFile.getFilePath();
    const workspaceDir = workspaceDirs.find(workspaceDir => filePath.startsWith(workspaceDir));
    const workspace = workspaces.find(workspace => workspace.dir === workspaceDir);

    if (workspace && (report.dependencies || report.unlisted)) {
      const externalModuleSpecifiers = _findExternalImportModuleSpecifiers(sourceFile);
      externalModuleSpecifiers.forEach(moduleSpecifier => {
        const unlistedDependency = deputy.maybeAddListedReferencedDependency(workspace, moduleSpecifier, isStrict);
        if (unlistedDependency) collector.addIssue({ type: 'unlisted', filePath, symbol: unlistedDependency });
      });
    }

    if (report.duplicates) {
      const duplicateExports = _findDuplicateExportedNames(sourceFile);
      duplicateExports.forEach(symbols => {
        const symbol = symbols.join('|');
        collector.addIssue({ type: 'duplicates', filePath, symbol, symbols });
      });
    }

    const issues = lab.analyzeSourceFile(sourceFile);

    issues.forEach(issue => issue.type && collector.addIssue(issue));
  });

  if (report.dependencies) {
    const { dependencyIssues, devDependencyIssues } = deputy.settleDependencyIssues();
    dependencyIssues.forEach(issue => collector.addIssue(issue));
    if (!isProduction) devDependencyIssues.forEach(issue => collector.addIssue(issue));
  }

  const { issues, counters } = collector.getIssues();

  collector.removeProgress();

  return { report: report as Report, issues, counters };
};
