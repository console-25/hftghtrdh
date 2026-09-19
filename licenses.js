'use strict';

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

/*
 * ============================================================
 * SIMPLE LOCAL LICENSE SYSTEM
 * ============================================================
 *
 * Change this to whatever license key you want.
 *
 * Example:
 *   NKVM-2026-PANEL
 *
 * The panel will accept ONLY this key.
 */

const SIMPLE_LICENSE_KEY = 'NKVM-2026-PANEL';

const DB_PATH = 'hvm.db';

let db = null;

/*
 * ------------------------------------------------------------
 * Database
 * ------------------------------------------------------------
 */

async function initLicenseStorage(customDbPath = null, sharedDb = null) {
    if (sharedDb) {
        db = sharedDb;
    } else {
        db = await open({
            filename: customDbPath || DB_PATH,
            driver: sqlite3.Database
        });
    }

    await db.exec(`
        CREATE TABLE IF NOT EXISTS license_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            status TEXT,
            license_key TEXT,
            activated_at TEXT,
            activated_by TEXT,
            last_check_at TEXT,
            last_error TEXT
        )
    `);

    const count = await db.get(
        'SELECT COUNT(*) AS cnt FROM license_state'
    );

    if (count.cnt === 0) {
        await db.run(`
            INSERT INTO license_state
            (id, status)
            VALUES (1, 'inactive')
        `);
    }
}

/*
 * ------------------------------------------------------------
 * State helpers
 * ------------------------------------------------------------
 */

async function getState() {
    if (!db) {
        await initLicenseStorage();
    }

    return await db.get(
        'SELECT * FROM license_state WHERE id = 1'
    );
}

async function updateState(fields) {
    if (!db || !fields || Object.keys(fields).length === 0) {
        return;
    }

    const columns = Object.keys(fields)
        .map(key => `${key} = ?`)
        .join(', ');

    const values = Object.values(fields);

    await db.run(
        `UPDATE license_state SET ${columns} WHERE id = 1`,
        values
    );
}

/*
 * ------------------------------------------------------------
 * License activation
 * ------------------------------------------------------------
 */

async function activateWithServer(licenseKey, activatedBy = 'web') {
    licenseKey = String(licenseKey || '').trim();

    if (!licenseKey) {
        return {
            success: false,
            message: 'License key is required.'
        };
    }

    /*
     * Local key comparison.
     */
    if (licenseKey !== SIMPLE_LICENSE_KEY) {
        await updateState({
            status: 'inactive',
            last_error: 'Invalid license key',
            last_check_at: new Date().toISOString()
        });

        return {
            success: false,
            message: 'Invalid license key.'
        };
    }

    /*
     * Correct key.
     */
    const now = new Date().toISOString();

    await updateState({
        status: 'active',
        license_key: licenseKey,
        activated_at: now,
        activated_by: activatedBy || 'web',
        last_check_at: now,
        last_error: null
    });

    console.log('[License] Local license activated successfully.');

    return {
        success: true,
        message: 'License activated successfully!'
    };
}

/*
 * Backwards-compatible wrapper.
 */
async function activateWithServerWrapped(
    licenseKey,
    activatedBy = 'web'
) {
    return await activateWithServer(
        licenseKey,
        activatedBy
    );
}

/*
 * ------------------------------------------------------------
 * Activation check
 * ------------------------------------------------------------
 */

async function isActivated() {
    const state = await getState();

    return !!(
        state &&
        state.status === 'active' &&
        state.license_key === SIMPLE_LICENSE_KEY
    );
}

/*
 * ------------------------------------------------------------
 * Status
 * ------------------------------------------------------------
 */

async function getStatusInfo() {
    const state = await getState();

    if (!state) {
        return {
            activated: false,
            status: 'inactive'
        };
    }

    return {
        ...state,
        activated: await isActivated()
    };
}

/*
 * ------------------------------------------------------------
 * Machine ID
 *
 * Kept only because some existing panel code may call it.
 * It is no longer used for license validation.
 * ------------------------------------------------------------
 */

async function getMachineId() {
    return 'local-license';
}

/*
 * ------------------------------------------------------------
 * Dummy compatibility functions
 *
 * These exist so older code does not crash if it calls them.
 * They no longer perform remote licensing.
 * ------------------------------------------------------------
 */

async function revalidateWithServer() {
    const active = await isActivated();

    return {
        success: active,
        message: active ? 'active' : 'inactive',
        data: {
            status: active ? 'active' : 'inactive'
        }
    };
}

async function getSignedEnvelope() {
    const active = await isActivated();

    if (!active) {
        return null;
    }

    return {
        status: 'active'
    };
}

async function deactivateLocal(reason = '') {
    await updateState({
        status: 'inactive',
        license_key: null,
        last_error: reason || null,
        last_check_at: new Date().toISOString()
    });

    console.log('[License] Local license deactivated.');
}

/*
 * ------------------------------------------------------------
 * License middleware
 * ------------------------------------------------------------
 */

function requiresLicense(fallback = null) {
    return function(req, res, next) {
        isActivated()
            .then(activated => {

                if (!activated) {

                    if (
                        fallback &&
                        typeof fallback === 'function'
                    ) {
                        return fallback(req, res, next);
                    }

                    return res.status(403).json({
                        error: 'License is not active',
                        message: 'This panel requires a valid license'
                    });
                }

                next();
            })
            .catch(error => {
                console.error(
                    '[License] Check error:',
                    error
                );

                return res.status(500).json({
                    error: 'Internal error',
                    message: 'Failed to verify license status'
                });
            });
    };
}

/*
 * ------------------------------------------------------------
 * Background revalidation
 *
 * No remote server anymore.
 * ------------------------------------------------------------
 */

function startBackgroundRevalidation() {
    console.log(
        '[License] Local license mode enabled. ' +
        'Remote revalidation disabled.'
    );
}

/*
 * ------------------------------------------------------------
 * Express API
 * ------------------------------------------------------------
 */

function initLicenseMiddleware(app) {

    /*
     * Initialize storage for license API.
     */
    app.use('/api/license', async (req, res, next) => {
        try {
            await initLicenseStorage();
            next();
        } catch (error) {
            console.error(
                '[License] Database initialization failed:',
                error
            );

            res.status(500).json({
                error: 'License system initialization failed'
            });
        }
    });

    /*
     * Status
     */
    app.get('/api/license/status', async (req, res) => {
        try {
            const status = await getStatusInfo();

            res.json(status);
        } catch (error) {
            console.error(
                '[License] Status error:',
                error
            );

            res.status(500).json({
                error: 'Failed to get license status'
            });
        }
    });

    /*
     * Activate
     */
    app.post('/api/license/activate', async (req, res) => {
        try {

            const {
                license_key,
                activated_by
            } = req.body;

            const result = await activateWithServer(
                license_key,
                activated_by
            );

            if (result.success) {
                return res.json({
                    success: true,
                    message: result.message
                });
            }

            return res.status(400).json({
                success: false,
                message: result.message
            });

        } catch (error) {

            console.error(
                '[License] Activation error:',
                error
            );

            res.status(500).json({
                error: 'Failed to activate license'
            });
        }
    });

    /*
     * Deactivate
     */
    app.post('/api/license/deactivate', async (req, res) => {
        try {

            const { reason } = req.body;

            await deactivateLocal(reason);

            res.json({
                success: true,
                message: 'License deactivated'
            });

        } catch (error) {

            console.error(
                '[License] Deactivation error:',
                error
            );

            res.status(500).json({
                error: 'Failed to deactivate license'
            });
        }
    });
}

/*
 * ------------------------------------------------------------
 * Compatibility exports
 * ------------------------------------------------------------
 */

module.exports = {

    /*
     * Kept for compatibility with code that imports them.
     */
    LICENSE_SERVER_URL: null,
    EMBEDDED_PUB_KEY_PEM: null,
    RECHECK_INTERVAL: 0,
    MAX_ENVELOPE_AGE: 0,

    /*
     * Core functions.
     */
    initLicenseStorage,
    getMachineId,
    isActivated,
    getSignedEnvelope,
    getStatusInfo,
    getState,
    updateState,

    /*
     * Activation.
     */
    activateWithServer,
    activateWithServerWrapped,
    revalidateWithServer,
    deactivateLocal,

    /*
     * Middleware.
     */
    startBackgroundRevalidation,
    requiresLicense,
    initLicenseMiddleware,

    /*
     * Compatibility.
     */
    attemptLicenseRecovery: async () => {},
    getServerUrl: () => null,

    /*
     * Old crypto functions.
     * Kept as harmless compatibility stubs in case another
     * part of the panel imports them.
     */
    decryptKey: () => null,
    encryptKey: () => null,
    verifySignedResponse: () => ({
        ok: false,
        data: null,
        message: 'Remote license verification disabled'
    }),
    getPublicKeyFingerprint: () => null
};