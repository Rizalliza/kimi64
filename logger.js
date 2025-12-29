// utils/simpleLogger.js
/**
 * Minimal logger replacement for the arbitrage system
 * Simplified interface without file logging or complex features
 */

// Simple log levels
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    SUCCESS: 1,
    WARNING: 2,
    ERROR: 3,
    CRITICAL: 4,
    ARBITRAGE: 1,
    PRICE: 1
};

// Current minimum level (can be changed)
let minLevel = LOG_LEVELS.DEBUG;

/**
 * Simple timestamp function
 */
function getTimestamp() {
    return new Date().toISOString();
}

/**
 * Format log message
 */
function formatMessage(level, module, message) {
    const timestamp = getTimestamp();
    const moduleStr = module ? `[${module}] ` : '';
    return `${timestamp} ${level.toUpperCase()} ${moduleStr}${message}`;
}

/**
 * Core logging function
 */
function log(level, module, message, ...args) {
    const levelValue = LOG_LEVELS[level.toUpperCase()];
    
    // Skip if below minimum level
    if (levelValue < minLevel) return;
    
    const formattedMessage = formatMessage(level, module, message);
    
    if (level.toUpperCase() === 'ERROR' || level.toUpperCase() === 'CRITICAL') {
        console.error(formattedMessage, ...args);
    } else {
        console.log(formattedMessage, ...args);
    }
}

/**
 * Individual log level functions
 */
const logger = {
    debug: (module, message, ...args) => log('DEBUG', module, message, ...args),
    info: (module, message, ...args) => log('INFO', module, message, ...args),
    success: (module, message, ...args) => log('SUCCESS', module, message, ...args),
    warn: (module, message, ...args) => log('WARNING', module, message, ...args),
    warning: (module, message, ...args) => log('WARNING', module, message, ...args),
    error: (module, message, ...args) => log('ERROR', module, message, ...args),
    critical: (module, message, ...args) => log('CRITICAL', module, message, ...args),
    arbitrage: (module, message, ...args) => log('ARBITRAGE', module, message, ...args),
    price: (module, message, ...args) => log('PRICE', module, message, ...args),

    // Compatibility functions for existing code
    logRoutingDecision: (message, ...args) => log('INFO', 'ROUTING', message, ...args),
    logProfit: (message, ...args) => log('SUCCESS', 'PROFIT', message, ...args),
    logArbitrageOpportunity: (message, ...args) => log('ARBITRAGE', 'OPPORTUNITY', message, ...args),
    logTransactionResult: (message, ...args) => log('INFO', 'TRANSACTION', message, ...args),

    // Configuration
    setMinLevel: (level) => {
        if (LOG_LEVELS[level.toUpperCase()] !== undefined) {
            minLevel = LOG_LEVELS[level.toUpperCase()];
        }
    }
};

module.exports = logger;
