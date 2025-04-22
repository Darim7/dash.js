/**
 * Custom Rate‑Based ABR Rule for dash.js v5
 * (unwrapped from an IIFE, global var style)
 */

var RBRule;  // ← global var, like LowestBitrateRuleTest

function RBRuleClass(config) {
    config = config || {};

    // grab factories/singletons
    var factory               = dashjs.FactoryMaker;
    var SwitchRequest         = factory.getClassFactoryByName('SwitchRequest');
    var Debug                 = factory.getSingletonFactoryByName('Debug');
    var DashMetrics           = factory.getSingletonFactoryByName('DashMetrics');
    var MetricsConstants = dashjs.MetricsConstants;
    var context               = this.context;
    var logger, dashMetrics;
    var lastQuality     = NaN;
    var consecutiveHigh = 0;
    var instance;

    function setup() {
        logger     = Debug(context).getInstance().getLogger(instance);
        dashMetrics = DashMetrics(context).getInstance();  
    }

    function getSwitchRequest(rulesContext) {
        try { 
            // console.log("[RB RULE] SWITCH REQUEST")
            // create a fresh request
            var switchRequest = SwitchRequest(context).create();
            switchRequest.rule = 'RBRule';

            // pull in controllers & state
            var mediaType            = rulesContext.getMediaType();
            var abrController        = rulesContext.getAbrController();
            var throughputController = rulesContext.getThroughputController();
            var scheduleController   = rulesContext.getScheduleController();
            var streamInfo           = rulesContext.getStreamInfo() || {};
            var streamId             = streamInfo.id;
            var isDynamic            = streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
            var bufState             = dashMetrics.getCurrentBufferState(mediaType);
            var bufferLevel          = dashMetrics.getCurrentBufferLevel(mediaType);
            var throughput           = throughputController.getSafeAverageThroughput(mediaType);
            var latency              = throughputController.getAverageLatency(mediaType);
            // console.log("[RB RULE] PAST? REQUEST") 
            // console.log(throughput) 
            if (isNaN(throughput)) {
                // not enough data yet skip ABR logic
                return switchRequest;
            }
            // console.log(bufState)
            // bail‑out conditions
            if (!bufState) { 
                // console.log("[RBRule] RETURNED EARLY")
                return switchRequest;
            } 
            console.log(bufState)
            if (abrController.getAbandonmentStateFor(streamId, mediaType) !== 'allowload') {
                logger.debug('[RBRule] Abandonment active – skipping ABR'); 
                // console.log("[RB RULE] ABANDON REQUEST")
                return switchRequest;
            }
            if (bufState.state !== 'bufferLoaded' && !isDynamic) {
                logger.debug('[RBRule] Buffer not loaded & not live – skipping ABR'); 
                // console.log("[RB RULE] BUFFER LOADED???")
                return switchRequest;
            } 
            // console.log("[RB RULE] Past Basic Checks")

            // fetch available representations correctly in v5
            var reps      = abrController.getPossibleVoRepresentations(
                               rulesContext.getMediaInfo(), true
                            );
            var bitrates  = reps.map(r => r.bandwidth/1000);  // in kbps
            var candidate = 0;  
            // console.log(reps)
            // console.log(bitrates)
            // console.log("Throughput:") 
            // console.log(throughput)
            // pick the highest index ≤ measured throughput
            for (var i = bitrates.length - 1; i >= 0; i--) {
                if (throughput >= bitrates[i]) {
                    candidate = i;
                    break;
                }
            }
            // console.log("[RB RULE] DID MATH") 
            // console.log(bufferLevel) 
            // console.log(candidate) 
            // console.log(lastQuality)

            // only allow up‑shift if stable
            if (!isNaN(lastQuality) && candidate > lastQuality) {
                if (consecutiveHigh >= 2 && bufferLevel > 5) {
                    logger.debug('[RBRule] Upshifting to', candidate);
                } else {
                    candidate = lastQuality;
                    logger.debug('[RBRule] Preventing up‑shift; stability insufficient');
                }
            } 

            // track sustainability
            if (!isNaN(lastQuality) && throughput >= bitrates[lastQuality]) {
                consecutiveHigh++;
            } else {
                consecutiveHigh = 0;
            }
            lastQuality = candidate;

            // build & return the decision
            switchRequest.representation = reps[candidate];
            switchRequest.priority       = SwitchRequest.PRIORITY.STRONG;
            switchRequest.reason         = {
                throughput,
                latency,
                message: `[RBRule] Switching to bitrate ${reps[candidate].bitrateInKbit} kbit/s`
            };
            return switchRequest;

        } catch (e) {
            logger.error(e);
            return SwitchRequest(context).create();
        }
    }

    function reset() {
        lastQuality     = NaN;
        consecutiveHigh = 0;
    }

    instance = {
        getSwitchRequest: getSwitchRequest,
        reset:            reset
    };

    setup();
    return instance;
}

// must match the string you’ll pass into addABRCustomRule()
RBRuleClass.__dashjs_factory_name = 'RBRule';
RBRule = dashjs.FactoryMaker.getClassFactory(RBRuleClass);
