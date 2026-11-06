#!/usr/bin/env node
import {main} from '../../../../scripts/cba-video/cli.mjs';
main().catch(error => { console.error(error.message); process.exitCode = 1; });
