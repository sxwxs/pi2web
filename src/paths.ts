import {homedir} from 'node:os';
import path from 'node:path';

/**
 * pi2web keeps its own state next to Pi's (`~/.pi/agent`): `~/.pi/pi2web` holds the metadata database,
 * pairing-code hashes and the shareable Agent templates. `PI2WEB_DIR` or `--data-dir` override it.
 */
export const defaultDataDir = () => process.env.PI2WEB_DIR || path.join(homedir(), '.pi', 'pi2web');
export const METADATA_DB_FILE = 'pi2web.db';
/** Shareable Agent templates: one Markdown file per template, see `agent-templates.ts`. */
export const AGENT_TEMPLATES_DIR = 'agent-templates';
