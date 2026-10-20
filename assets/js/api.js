/**
 * P1 Monitor API Handler
 * Centralized API calls for all P1 Monitor endpoints
 *
 * All P1 Monitor API calls use ?json=object to receive responses with
 * named properties (e.g. record.TIMESTAMP_UTC) instead of positional
 * arrays (e.g. record[1]). This makes the code resilient to API
 * field-order changes and self-documenting.
 */

(function() {
    'use strict';

    const P1API = {
        // Base API paths
        BASE_PATH: '/api',

        // Cache for API responses (short-lived)
        cache: new Map(),
        CACHE_DURATION: 5000, // 5 seconds

        // Connection monitoring
        connectionStatus: {
            isOnline: true,
            consecutiveFailures: 0,
            lastSuccessTime: Date.now(),
            MAX_FAILURES: 3
        },

        /**
         * Generic fetch wrapper with error handling.
         * Automatically appends json=object to P1 Monitor API calls
         * so responses use named properties instead of positional arrays.
         */
        async fetch(endpoint, options = {}) {
            // Auto-append json=object for P1 Monitor API endpoints
            let url = endpoint;
            if (url.startsWith(this.BASE_PATH)) {
                const separator = url.includes('?') ? '&' : '?';
                url += separator + 'json=object';
            }

            try {
                const response = await fetch(url, {
                    ...options,
                    headers: {
                        'Content-Type': 'application/json',
                        ...options.headers
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();

                // Mark as successful connection
                this.markConnectionSuccess();

                return data;

            } catch (error) {
                P1Logger.error(`API Error (${endpoint}):`, error);

                // Mark as failed connection
                this.markConnectionFailure();

                throw error;
            }
        },

        /**
         * Mark connection as successful
         */
        markConnectionSuccess() {
            const wasOffline = !this.connectionStatus.isOnline;

            this.connectionStatus.isOnline = true;
            this.connectionStatus.consecutiveFailures = 0;
            this.connectionStatus.lastSuccessTime = Date.now();

            // Dispatch event if we just came back online
            if (wasOffline) {
                this.dispatchConnectionEvent('online');
            }
        },

        /**
         * Mark connection as failed
         */
        markConnectionFailure() {
            this.connectionStatus.consecutiveFailures++;

            // Mark as offline after MAX_FAILURES
            if (this.connectionStatus.consecutiveFailures >= this.connectionStatus.MAX_FAILURES) {
                const wasOnline = this.connectionStatus.isOnline;
                this.connectionStatus.isOnline = false;

                // Dispatch event if we just went offline
                if (wasOnline) {
                    this.dispatchConnectionEvent('offline');
                }
            }
        },

        /**
         * Dispatch connection status event
         */
        dispatchConnectionEvent(status) {
            const event = new CustomEvent('p1connection', {
                detail: {
                    status: status,
                    isOnline: this.connectionStatus.isOnline,
                    consecutiveFailures: this.connectionStatus.consecutiveFailures,
                    lastSuccessTime: this.connectionStatus.lastSuccessTime
                }
            });

            document.dispatchEvent(event);
            P1Logger.log(`P1 API Connection: ${status}`);
        },

        /**
         * Get connection status
         */
        getConnectionStatus() {
            return {
                ...this.connectionStatus,
                timeSinceLastSuccess: Date.now() - this.connectionStatus.lastSuccessTime
            };
        },

        /**
         * Fetch with caching
         */
        async fetchCached(endpoint, options = {}) {
            const cacheKey = endpoint;
            const now = Date.now();

            // Check cache
            if (this.cache.has(cacheKey)) {
                const cached = this.cache.get(cacheKey);
                if (now - cached.timestamp < this.CACHE_DURATION) {
                    return cached.data;
                }
            }

            // Fetch fresh data
            const data = await this.fetch(endpoint, options);

            // Store in cache and evict expired entries
            this.cache.set(cacheKey, {
                data: data,
                timestamp: now
            });
            this.evictExpired(now);

            return data;
        },

        /**
         * Remove expired entries from cache
         */
        evictExpired(now) {
            this.cache.forEach((entry, key) => {
                if (now - entry.timestamp >= this.CACHE_DURATION) {
                    this.cache.delete(key);
                }
            });
        },

        /**
         * Clear cache
         */
        clearCache(endpoint = null) {
            if (endpoint) {
                this.cache.delete(endpoint);
            } else {
                this.cache.clear();
            }
        },

        // ========================================================================
        // SMART METER APIs
        // ========================================================================

        /**
         * Get smart meter data (real-time readings)
         * Response fields: TIMESTAMP_lOCAL, TIMESTAMP_UTC, RECORD_IS_PROCESSED,
         *   CONSUMPTION_KWH_LOW, CONSUMPTION_KWH_HIGH, PRODUCTION_KWH_LOW,
         *   PRODUCTION_KWH_HIGH, TARIFCODE, CONSUMPTION_W, PRODUCTION_W,
         *   CONSUMPTION_GAS_M3
         * @param {number} limit - Number of records to fetch (default: 60)
         * @returns {Promise<Array>}
         */
        async getSmartMeter(limit = 60) {
            return this.fetch(`${this.BASE_PATH}/v1/smartmeter?limit=${limit}`);
        },

        /**
         * Get status data (peaks, phases, totals)
         * Response fields: STATUS_ID, STATUS, LABEL, SECURITY
         * @returns {Promise<Array>}
         */
        async getStatus() {
            return this.fetch(`${this.BASE_PATH}/v1/status`);
        },

        /**
         * Get configuration settings
         * Response fields: CONFIGURATION_ID, PARAMETER, LABEL
         * @returns {Promise<Array>}
         */
        async getConfiguration() {
            return this.fetchCached(`${this.BASE_PATH}/v1/configuration`);
        },

        // ========================================================================
        // HISTORY APIs
        // ========================================================================

        /**
         * Get power and gas history by day
         * @param {number} limit - Number of days (default: 1)
         * @returns {Promise<Array>}
         */
        async getHistoryDay(limit = 1) {
            return this.fetch(`${this.BASE_PATH}/v1/powergas/day?limit=${limit}`);
        },

        /**
         * Get power and gas history by month
         * @param {number} limit - Number of months (default: 12)
         * @returns {Promise<Array>}
         */
        async getHistoryMonth(limit = 12) {
            return this.fetch(`${this.BASE_PATH}/v1/powergas/month?limit=${limit}`);
        },

        /**
         * Get power and gas history by year
         * @param {number} limit - Number of years (default: 5)
         * @returns {Promise<Array>}
         */
        async getHistoryYear(limit = 5) {
            return this.fetch(`${this.BASE_PATH}/v1/powergas/year?limit=${limit}`);
        },

        /**
         * Get power and gas history by hour
         * @param {number} limit - Number of hours (default: 24)
         * @returns {Promise<Array>}
         */
        async getHistoryHour(limit = 24) {
            return this.fetchCached(`${this.BASE_PATH}/v1/powergas/hour?limit=${limit}`);
        },

        // ========================================================================
        // FINANCIAL APIs
        // ========================================================================

        /**
         * Get financial data by day
         * Response fields: TIMESTAMP_lOCAL, TIMESTAMP_UTC,
         *   CONSUMPTION_COST_ELECTRICITY_HIGH, CONSUMPTION_COST_ELECTRICITY_LOW,
         *   PRODUCTION_REVENUES_ELECTRICITY_HIGH, PRODUCTION_REVENUES_ELECTRICITY_LOW,
         *   CONSUMPTION_COST_GAS, CONSUMPTION_COST_WATER
         * @param {number} limit - Number of days (default: 1)
         * @returns {Promise<Array>}
         */
        async getFinancial(limit = 1) {
            return this.fetch(`${this.BASE_PATH}/v1/financial/day?limit=${limit}`);
        },

        /**
         * Get financial data by month
         * @param {number} limit - Number of months (default: 12)
         * @returns {Promise<Array>}
         */
        async getFinancialMonth(limit = 12) {
            return this.fetch(`${this.BASE_PATH}/v1/financial/month?limit=${limit}`);
        },

        /**
         * Get financial data by year
         * @param {number} limit - Number of years (default: 5)
         * @returns {Promise<Array>}
         */
        async getFinancialYear(limit = 5) {
            return this.fetch(`${this.BASE_PATH}/v1/financial/year?limit=${limit}`);
        },

        // ========================================================================
        // WATER METER APIs
        // ========================================================================

        /**
         * Get water meter data by day
         * @param {number} limit - Number of days (default: 1)
         * @returns {Promise<Array>}
         */
        async getWaterMeter(limit = 1) {
            return this.fetch(`${this.BASE_PATH}/v2/watermeter/day?limit=${limit}`);
        },

        /**
         * Get water meter data by month
         * @param {number} limit - Number of months (default: 12)
         * @returns {Promise<Array>}
         */
        async getWaterMeterMonth(limit = 12) {
            return this.fetch(`${this.BASE_PATH}/v2/watermeter/month?limit=${limit}`);
        },

        // ========================================================================
        // WEATHER API
        // ========================================================================

        /**
         * Get weather history for a specific period
         * Uses period-specific weather endpoints (hour, day, month, year).
         * @param {string} period - 'hours', 'days', 'months', 'years'
         * @param {number} limit - Number of records to fetch
         * @returns {Promise<Array>} Array of weather records (named properties)
         */
        async getWeatherHistory(period = 'hours', limit = 24) {
            try {
                const periodMap = {
                    hours: 'hour',
                    days: 'day',
                    months: 'month',
                    years: 'year'
                };
                const endpoint = periodMap[period];
                if (!endpoint) return [];

                const data = await this.fetch(
                    `${this.BASE_PATH}/v1/weather/${endpoint}?limit=${limit}`
                );
                return Array.isArray(data) ? data : [];
            } catch (error) {
                P1Logger.warn('Weather history not available:', error);
                return [];
            }
        },

        /**
         * Process weather history into a lookup map keyed by period timestamp.
         * Weather history endpoints return pre-aggregated TEMPERATURE_LOW,
         * TEMPERATURE_AVERAGE, TEMPERATURE_HIGH per period.
         * @param {Array} weatherData - Raw weather records from /api/v1/weather/{period}
         * @param {string} period - 'hours', 'days', 'months', 'years'
         * @returns {Object} Map of { [periodKey]: { min, max, avg } }
         */
        processTemperatureData(weatherData, period = 'hours') {
            const tempMap = {};

            weatherData.forEach(record => {
                const timestamp = parseInt(record.TIMESTAMP_UTC);
                if (isNaN(timestamp)) return;

                const key = P1Utils.getPeriodKey(timestamp, period);

                const min = parseFloat(record.TEMPERATURE_LOW);
                const max = parseFloat(record.TEMPERATURE_HIGH);
                const avg = parseFloat(record.TEMPERATURE_AVERAGE);

                if (isNaN(min) && isNaN(max) && isNaN(avg)) return;

                const degreeDays = parseFloat(record.DEGREE_DAYS);

                tempMap[key] = {
                    min: isNaN(min) ? avg : min,
                    max: isNaN(max) ? avg : max,
                    avg: isNaN(avg) ? (min + max) / 2 : avg,
                    degreeDays: isNaN(degreeDays) ? null : degreeDays
                };
            });

            return tempMap;
        },

        /**
         * Join weather onto chart points (one weather request per call).
         * Returns new point objects with tempMin, tempAvg, tempMax and
         * degreeDays where the weather history has a matching bucket.
         * @param {Array} points - chart points with unixTimestamp
         * @param {string} period - 'hours', 'days', 'months', 'years'
         * @param {number} limit - number of buckets
         */
        async attachWeather(points, period, limit) {
            const weather = this.processTemperatureData(await this.getWeatherHistory(period, limit), period);
            return this.joinWeather(points, weather, period);
        },

        /**
         * Join an already processed weather map (processTemperatureData)
         * onto chart points; see attachWeather()
         */
        joinWeather(points, weather, period) {
            return points.map(point => {
                const w = weather[P1Utils.getPeriodKey(point.unixTimestamp, period)];
                if (!w) return point;
                return Object.assign({}, point, {
                    tempMin: w.min,
                    tempAvg: w.avg,
                    tempMax: w.max,
                    degreeDays: w.degreeDays
                });
            });
        },

        // ========================================================================
        // PHASE APIs
        // ========================================================================

        /**
         * Get phase data (L1, L2, L3) from status endpoint
         * @returns {Promise<Object>}
         */
        async getPhases() {
            const status = await this.getStatus();
            const phases = {
                consumption: [0, 0, 0],
                production: [0, 0, 0],
                voltage: [0, 0, 0],
                current: [0, 0, 0]
            };

            status.forEach(item => {
                switch(item.STATUS_ID) {
                    // Consumption power per phase
                    case 74: phases.consumption[0] = parseFloat(item.STATUS); break;
                    case 75: phases.consumption[1] = parseFloat(item.STATUS); break;
                    case 76: phases.consumption[2] = parseFloat(item.STATUS); break;
                    // Production power per phase
                    case 77: phases.production[0] = parseFloat(item.STATUS); break;
                    case 78: phases.production[1] = parseFloat(item.STATUS); break;
                    case 79: phases.production[2] = parseFloat(item.STATUS); break;
                }
            });

            return phases;
        },

        // ========================================================================
        // UTILITY METHODS
        // ========================================================================

        /**
         * Get electricity data with statistics for a window of buckets.
         *
         * Windows are counted in buckets back from the newest: page 0 is the
         * latest `limit` buckets, page 1 the `limit` before that, and so on.
         * The window before the requested one is fetched too, so callers can
         * compare against the previous period (`previous`).
         *
         * @param {string} period - 'hours', 'days', 'months', 'years'
         * @param {number} limit - Buckets per window
         * @param {boolean} includeTemperature - Join weather onto the points
         * @param {Object} options - { page: 0 }
         * @returns {Promise<Object|null>} { period, limit, page, chartData, stats, previous }
         */
        async getElectricityData(period = 'hours', limit = 24, includeTemperature = false, options = {}) {
            const page = Math.max(0, options.page || 0);
            const fetchLimit = limit * (page + 2);

            try {
                let historyData;
                let financialData = null;

                switch (period) {
                    case 'hours':
                        historyData = await this.getHistoryHour(fetchLimit);
                        break;
                    case 'days':
                        historyData = await this.getHistoryDay(fetchLimit);
                        financialData = await this.getFinancial(fetchLimit).catch(() => null);
                        break;
                    case 'months':
                        historyData = await this.getHistoryMonth(fetchLimit);
                        financialData = await this.getFinancialMonth(fetchLimit).catch(() => null);
                        break;
                    case 'years':
                        historyData = await this.getHistoryYear(fetchLimit);
                        financialData = await this.getFinancialYear(fetchLimit).catch(() => null);
                        break;
                    default:
                        throw new Error('Invalid period: ' + period);
                }

                if (!historyData || historyData.length === 0) {
                    return null;
                }

                // API returns newest first; slice windows, then make each chronological.
                // slice() copies, so the fetchCached reference is never mutated.
                const current = historyData.slice(page * limit, (page + 1) * limit).reverse();
                const previous = historyData.slice((page + 1) * limit, (page + 2) * limit).reverse();

                if (current.length === 0) {
                    return null;
                }

                let temperatureMap = null;
                if (includeTemperature) {
                    const weatherData = await this.getWeatherHistory(period, limit * (page + 1));
                    temperatureMap = this.processTemperatureData(weatherData, period);
                }

                const chartData = current.map(row => this.electricityPoint(row, period, temperatureMap));

                return {
                    period,
                    limit,
                    page,
                    chartData,
                    stats: this.electricityStats(current, financialData),
                    previous: previous.length === limit ? this.electricityStats(previous, financialData) : null,
                    hasOlder: previous.length > 0
                };

            } catch (error) {
                P1Logger.error('Error fetching electricity data:', error);
                throw error;
            }
        },

        /**
         * Costs per bucket from P1 Monitor's financial data, windowed like
         * getElectricityData(): page 0 is the newest `limit` buckets, and the
         * window before it is returned as `previous` for comparisons.
         *
         * P1 Monitor has financial data per day, month and year (no hours).
         * Its figures exclude fixed charges (vastrecht).
         *
         * @param {string} period - 'days', 'months', 'years'
         * @param {number} limit - Buckets per window
         * @param {Object} options - { page: 0 }
         * @returns {Promise<Object|null>} { period, limit, page, chartData, stats, previous, hasOlder }
         *   chartData: [{ timestamp, unixTimestamp, electricity, gas, water, revenue, net }]
         *   revenue is negative (money received), so it stacks below zero.
         */
        async getCostData(period = 'days', limit = 7, options = {}) {
            const page = Math.max(0, options.page || 0);
            const fetchLimit = limit * (page + 2);

            const fetchers = {
                days: () => this.getFinancial(fetchLimit),
                months: () => this.getFinancialMonth(fetchLimit),
                years: () => this.getFinancialYear(fetchLimit)
            };
            if (!fetchers[period]) throw new Error('No financial data for period: ' + period);

            const history = { days: 'getHistoryDay', months: 'getHistoryMonth', years: 'getHistoryYear' }[period];
            const [financial, powergas] = await Promise.all([
                fetchers[period](),
                this[history](fetchLimit).catch(() => null)
            ]);
            if (!Array.isArray(financial) || financial.length === 0) return null;
            const rows = this.guardGasCost(financial, powergas);

            // Newest first from the API; slice windows, then make them chronological
            const current = rows.slice(page * limit, (page + 1) * limit).reverse().map(r => this.costPoint(r));
            const previous = rows.slice((page + 1) * limit, (page + 2) * limit).reverse().map(r => this.costPoint(r));
            if (current.length === 0) return null;

            return {
                period,
                limit,
                page,
                chartData: current,
                stats: this.costStats(current),
                previous: previous.length === limit ? this.costStats(previous) : null,
                hasOlder: previous.length > 0
            };
        },

        /**
         * P1 Monitor's financial gas cost can be wildly wrong for a bucket
         * while its powergas gas volume for the same bucket is fine (seen as a
         * ~EUR 8,000 gas month next to 5 m³ of gas). Cost per m³ normally
         * stays within a small multiple of the configured tariff, so any bucket
         * far above that is replaced by volume × tariff. Returns copies of the
         * rows; rows without a matching powergas bucket are left untouched.
         *
         * @param {Array} financialRows - financial rows (any order)
         * @param {Array} powergasRows - powergas rows for the same period
         * @returns {Array} rows, with `gasCostEstimated: true` on corrected ones
         */
        guardGasCost(financialRows, powergasRows) {
            if (!Array.isArray(financialRows) || !Array.isArray(powergasRows)) return financialRows;

            const m3ByTime = new Map(powergasRows.map(r => [String(r.TIMESTAMP_UTC), parseFloat(r.CONSUMPTION_GAS_DELTA_M3)]));
            const tariff = P1Utils.tariffs().gas;

            return financialRows.map(row => {
                const m3 = m3ByTime.get(String(row.TIMESTAMP_UTC));
                const cost = parseFloat(row.CONSUMPTION_COST_GAS);
                if (!Number.isFinite(m3) || !Number.isFinite(cost)) return row;

                const estimate = Math.max(m3, 0) * tariff;
                if (cost <= estimate * this.GAS_COST_TOLERANCE + 1) return row;

                P1Logger.warn(`Gas cost € ${cost.toFixed(2)} for ${row.TIMESTAMP_lOCAL} does not match ${m3.toFixed(2)} m³; using € ${estimate.toFixed(2)}`);
                return { ...row, CONSUMPTION_COST_GAS: estimate, gasCostEstimated: true };
            });
        },

        // Gas cost above this multiple of volume × tariff (+ EUR 1) is treated as bad data
        GAS_COST_TOLERANCE: 3,

        costPoint(row) {
            const num = (key) => parseFloat(row[key] || 0) || 0;
            const electricity = num('CONSUMPTION_COST_ELECTRICITY_HIGH') + num('CONSUMPTION_COST_ELECTRICITY_LOW');
            const gas = num('CONSUMPTION_COST_GAS');
            const water = num('CONSUMPTION_COST_WATER');
            const revenue = -(num('PRODUCTION_REVENUES_ELECTRICITY_HIGH') + num('PRODUCTION_REVENUES_ELECTRICITY_LOW'));

            return {
                timestamp: row.TIMESTAMP_lOCAL,
                unixTimestamp: parseInt(row.TIMESTAMP_UTC),
                electricity,
                gas,
                water,
                revenue,
                net: electricity + gas + water + revenue
            };
        },

        /**
         * Totals for a window of cost points. revenue is returned positive.
         */
        costStats(points) {
            const sum = (key) => points.reduce((s, p) => s + p[key], 0);
            const peak = points.reduce((best, p) => (p.net > best.value ? { value: p.net, time: p.timestamp } : best),
                { value: -Infinity, time: null });

            const gross = sum('electricity') + sum('gas') + sum('water');
            const revenue = -sum('revenue');
            const net = gross - revenue;

            return {
                electricity: sum('electricity'),
                gas: sum('gas'),
                water: sum('water'),
                gross,
                revenue,
                net,
                average: points.length ? net / points.length : 0,
                peak: peak.time ? peak : { value: 0, time: null },
                from: points[0].unixTimestamp,
                to: points[points.length - 1].unixTimestamp
            };
        },

        /**
         * One chart point from a powergas row
         */
        electricityPoint(row, period, temperatureMap) {
            const consumption = parseFloat(row.CONSUMPTION_DELTA_KWH || 0);
            const production = parseFloat(row.PRODUCTION_DELTA_KWH || 0);
            const unixTimestamp = parseInt(row.TIMESTAMP_UTC);

            const point = {
                timestamp: row.TIMESTAMP_lOCAL,
                unixTimestamp,
                consumption,
                production,
                net: consumption - production,
                gas: parseFloat(row.CONSUMPTION_GAS_DELTA_M3 || 0)
            };

            const temps = temperatureMap && unixTimestamp
                ? temperatureMap[P1Utils.getPeriodKey(unixTimestamp, period)]
                : null;
            if (temps) {
                point.tempMin = temps.min;
                point.tempMax = temps.max;
                point.tempAvg = temps.avg;
            }

            return point;
        },

        /**
         * Totals for a window of powergas rows (chronological).
         * Costs come from the financial rows that fall inside the window;
         * without them they are estimated from the configured tariffs (P1Utils.tariffs).
         */
        electricityStats(rows, financialData) {
            let totalConsumption = 0;
            let totalProduction = 0;
            let totalGas = 0;
            const peakConsumption = { value: 0, time: '' };

            rows.forEach(row => {
                const consumption = parseFloat(row.CONSUMPTION_DELTA_KWH || 0);
                totalConsumption += consumption;
                totalProduction += parseFloat(row.PRODUCTION_DELTA_KWH || 0);
                totalGas += parseFloat(row.CONSUMPTION_GAS_DELTA_M3 || 0);

                if (consumption > peakConsumption.value) {
                    peakConsumption.value = consumption;
                    peakConsumption.time = row.TIMESTAMP_lOCAL;
                }
            });

            const first = parseInt(rows[0]?.TIMESTAMP_UTC);
            const last = parseInt(rows[rows.length - 1]?.TIMESTAMP_UTC);
            const financial = this.guardGasCost((financialData || []).filter(row => {
                const ts = parseInt(row.TIMESTAMP_UTC);
                return ts >= first && ts <= last;
            }), rows);

            let totalCost;
            let gasCost;
            if (financial.length > 0) {
                gasCost = financial.reduce((sum, row) => sum + parseFloat(row.CONSUMPTION_COST_GAS || 0), 0);
                totalCost = financial.reduce((sum, row) => sum
                    + parseFloat(row.CONSUMPTION_COST_ELECTRICITY_HIGH || 0)
                    + parseFloat(row.CONSUMPTION_COST_ELECTRICITY_LOW || 0)
                    - parseFloat(row.PRODUCTION_REVENUES_ELECTRICITY_HIGH || 0)
                    - parseFloat(row.PRODUCTION_REVENUES_ELECTRICITY_LOW || 0), 0);
            } else {
                // Estimate from the tariffs configured in P1 Monitor (P1Utils.tariffs)
                totalCost = P1Utils.estimateElectricityCost(totalConsumption, totalProduction);
                gasCost = totalGas * P1Utils.tariffs().gas;
            }

            return {
                totalConsumption,
                totalProduction,
                netConsumption: totalConsumption - totalProduction,
                totalGas,
                totalCost,
                gasCost,
                costIsEstimate: financial.length === 0,
                average: rows.length > 0 ? totalConsumption / rows.length : 0,
                peakConsumption,
                from: first,
                to: last
            };
        }
    };

    // Expose API globally
    window.P1API = P1API;

    P1Logger.log('P1 API Handler initialized');

})();
