// @flow
import R from 'ramda';
import { Consumer } from '..';
import { BitId } from '../../bit-id';
import GeneralError from '../../error/general-error';
import Component from '../component/consumer-component';
import { SourceFile } from '../component/sources';
import { Tmp } from '../../scope/repositories';
import diffFiles from '../../utils/diff-files';
import type { PathLinux, PathOsBased } from '../../utils/path';
import { Version } from '../../scope/models';
import { diffBetweenComponentsObjects } from './components-object-diff';
import ShowDoctorError from '../../error/show-doctor-error';

type FileDiff = { filePath: string, diffOutput: string };
export type FieldsDiff = { fieldName: string, diffOutput: string };
export type DiffResults = { id: BitId, hasDiff: boolean, filesDiff?: FileDiff[], fieldsDiff?: ?(FieldsDiff[]) };

export default (async function componentsDiff(
  consumer: Consumer,
  ids: BitId[],
  version: ?string,
  toVersion: ?string,
  verbose: boolean // whether show internal components diff, such as sourceRelativePath
): Promise<DiffResults[]> {
  const { components } = await consumer.loadComponents(ids);
  if (!components) throw new ShowDoctorError('failed loading the components');
  const tmp = new Tmp(consumer.scope);

  // try to resolve ids scope of by components array
  const idsWithScope = ids.map((id) => {
    if (!id.scope && components) {
      const foundComponent = components.find(o => o.name === id.name);
      if (foundComponent) return id.changeScope(foundComponent.scope);
    }
    return id;
  });

  try {
    const getResults = (): Promise<DiffResults[]> => {
      if (version && toVersion) {
        return Promise.all(idsWithScope.map(id => getComponentDiffBetweenVersions(id)));
      }
      if (version) {
        return Promise.all(components.map(component => getComponentDiffOfVersion(component)));
      }
      return Promise.all(components.map(component => getComponentDiff(component)));
    };
    const componentsDiffResults = await getResults();
    await tmp.clear();
    return componentsDiffResults;
  } catch (err) {
    await tmp.clear();
    throw err;
  }

  async function getComponentDiffOfVersion(component: Component): Promise<DiffResults> {
    const diffResult: DiffResults = { id: component.id, hasDiff: false };
    const modelComponent = await consumer.scope.getModelComponentIfExist(component.id);
    if (!modelComponent) {
      throw new GeneralError(`component ${component.id.toString()} doesn't have any version yet`);
    }
    const repository = consumer.scope.objects;
    const fromVersionObject: Version = await modelComponent.loadVersion(version, repository);
    const versionFiles = await fromVersionObject.modelFilesToSourceFiles(repository);
    const fsFiles = component.files;
    // $FlowFixMe version must be defined as the component.componentFromModel do exist
    const versionB: string = component.id.version;
    // $FlowFixMe this function gets called only when version is set
    diffResult.filesDiff = await getFilesDiff(tmp, versionFiles, fsFiles, version, versionB);
    const fromVersionComponent = await modelComponent.toConsumerComponent(version, consumer.scope.name, repository);
    await updateFieldsAndEnvsDiff(fromVersionComponent, component, diffResult);

    return diffResult;
  }

  async function getComponentDiffBetweenVersions(id: BitId): Promise<DiffResults> {
    const diffResult: DiffResults = { id, hasDiff: false };
    const modelComponent = await consumer.scope.getModelComponentIfExist(id);
    if (!modelComponent) {
      throw new GeneralError(`component ${id.toString()} doesn't have any version yet`);
    }
    const repository = consumer.scope.objects;
    const fromVersionObject: Version = await modelComponent.loadVersion(version, repository);
    const toVersionObject: Version = await modelComponent.loadVersion(toVersion, repository);
    const fromVersionFiles = await fromVersionObject.modelFilesToSourceFiles(repository);
    const toVersionFiles = await toVersionObject.modelFilesToSourceFiles(repository);
    // $FlowFixMe version and toVersion are set when calling this function
    diffResult.filesDiff = await getFilesDiff(tmp, fromVersionFiles, toVersionFiles, version, toVersion);
    const fromVersionComponent = await modelComponent.toConsumerComponent(version, consumer.scope.name, repository);
    const toVersionComponent = await modelComponent.toConsumerComponent(toVersion, consumer.scope.name, repository);
    await updateFieldsAndEnvsDiff(fromVersionComponent, toVersionComponent, diffResult);

    return diffResult;
  }

  async function getComponentDiff(component: Component): Promise<DiffResults> {
    const diffResult = { id: component.id, hasDiff: false };
    if (!component.componentFromModel) {
      // it's a new component. not modified. nothing to check.
      return diffResult;
    }
    const modelFiles = component.componentFromModel.files;
    const fsFiles = component.files;
    // $FlowFixMe version must be defined as the component.componentFromModel do exist
    diffResult.filesDiff = await getFilesDiff(tmp, modelFiles, fsFiles, component.id.version, component.id.version);
    // $FlowFixMe we made sure already that component.componentFromModel is defined
    await updateFieldsAndEnvsDiff(component.componentFromModel, component, diffResult);

    return diffResult;
  }

  async function updateFieldsAndEnvsDiff(componentA: Component, componentB: Component, diffResult: DiffResults) {
    const envsFilesDiff = await getEnvFilesDiff(tmp, consumer, componentA, componentB);
    // $FlowFixMe diffResult.filesDiff is populated at this point
    diffResult.filesDiff = diffResult.filesDiff.concat(envsFilesDiff);
    diffResult.fieldsDiff = diffBetweenComponentsObjects(consumer, componentA, componentB, verbose);
    diffResult.hasDiff = hasDiff(diffResult);
  }
});

function hasDiff(diffResult: DiffResults): boolean {
  return !!((diffResult.filesDiff && diffResult.filesDiff.find(file => file.diffOutput)) || diffResult.fieldsDiff);
}

async function getOneFileDiff(
  filePathA: PathOsBased,
  filePathB: PathOsBased,
  fileALabel: string,
  fileBLabel: string,
  fileName: PathLinux
): Promise<string> {
  const fileDiff = await diffFiles(filePathA, filePathB);
  if (!fileDiff) return '';
  const diffStartsString = '--- '; // the part before this string is not needed for our purpose
  const diffStart = fileDiff.indexOf(diffStartsString);
  if (!diffStart || diffStart < 1) return ''; // invalid diff

  // e.g. Linux: --- a/private/var/folders/z ... .js
  // Windows: --- "a/C:\\Users\\David\\AppData\\Local\\Temp\\bit ... .js
  const regExpA = /--- ["]?a.*\n/; // exact "---", follow by a or "a (for Windows) then \n
  const regExpB = /\+\+\+ ["]?b.*\n/; // exact "+++", follow by b or "b (for Windows) then \n
  return fileDiff
    .substr(diffStart)
    .replace(regExpA, `--- ${fileName} (${fileALabel})\n`)
    .replace(regExpB, `+++ ${fileName} (${fileBLabel})\n`);
}

async function getEnvFilesDiff(
  tmp: Tmp,
  consumer: Consumer,
  componentA: Component,
  componentB: Component
): Promise<FileDiff[]> {
  const envs = ['compiler', 'tester'];
  const envsDiffP = envs.map((env) => {
    // $FlowFixMe
    const filesA = componentA[env] && componentA[env].files ? componentA[env].files : [];
    // $FlowFixMe
    const filesB = componentB[env] && componentB[env].files ? componentB[env].files : [];
    const filesAVersion = componentA.version;
    const filesBVersion = componentB.version;
    if (!filesAVersion || !filesBVersion) {
      throw new Error('diffBetweenComponentsObjects component does not have a version');
    }
    return getFilesDiff(tmp, filesA, filesB, filesAVersion, filesBVersion, 'name');
  });
  const envsDiff = await Promise.all(envsDiffP);
  return R.flatten(envsDiff);
}

async function getFilesDiff(
  tmp: Tmp,
  filesA: SourceFile[],
  filesB: SourceFile[],
  filesAVersion: string,
  filesBVersion: string,
  fileNameAttribute?: string = 'relative'
): Promise<FileDiff[]> {
  const filesAPaths = filesA.map(f => f[fileNameAttribute]);
  const filesBPaths = filesB.map(f => f[fileNameAttribute]);
  const allPaths = R.uniq(filesAPaths.concat(filesBPaths));
  const fileALabel = filesAVersion === filesBVersion ? `${filesAVersion} original` : filesAVersion;
  const fileBLabel = filesAVersion === filesBVersion ? `${filesBVersion} modified` : filesBVersion;
  const filesDiffP = allPaths.map(async (relativePath) => {
    const getFilePath = async (files): Promise<PathOsBased> => {
      const file = files.find(f => f[fileNameAttribute] === relativePath);
      const fileContent = file ? file.contents : '';
      return tmp.save(fileContent);
    };
    const [fileAPath, fileBPath] = await Promise.all([getFilePath(filesA), getFilePath(filesB)]);
    const diffOutput = await getOneFileDiff(fileAPath, fileBPath, fileALabel, fileBLabel, relativePath);
    return { filePath: relativePath, diffOutput };
  });
  return Promise.all(filesDiffP);
}
