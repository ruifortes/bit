/** @flow */

import R from 'ramda';
import fs from 'fs-extra';
import Diagnosis from '../diagnosis';
import type { ExamineBareResult } from '../diagnosis';
import { loadConsumer } from '../../consumer';
import ConsumerBitConfig from '../../consumer/bit-config/consumer-bit-config';
import AbstractBitConfig from '../../consumer/bit-config/abstract-bit-config';

export default class ValidateWorkspaceBitJsonSyntax extends Diagnosis {
  name = 'validate-workspace-bit-json-syntax';
  description = 'validate that the workspace bit.json syntax is valid';
  category = 'bit-core-files';

  _formatSymptoms(bareResult: ExamineBareResult): string {
    const bitJsonPath = R.path(['data', 'bitJsonPath'], bareResult);
    return `invalid bit.json: ${bitJsonPath} is not a valid JSON file.`;
  }

  _formatManualTreat() {
    return 'consider running bit init --reset to recreate the file';
  }

  async _runExamine(): Promise<ExamineBareResult> {
    const consumer = await loadConsumer();
    const consumerPath = consumer.getPath();
    const bitJsonPath = AbstractBitConfig.composeBitJsonPath(consumerPath);
    const exist = await fs.exists(bitJsonPath);
    if (!exist) {
      return {
        valid: true
      };
    }
    try {
      ConsumerBitConfig.loadBitJson(bitJsonPath);
      return {
        valid: true
      };
    } catch (e) {
      return {
        valid: false,
        data: {
          bitJsonPath
        }
      };
    }
  }
}
