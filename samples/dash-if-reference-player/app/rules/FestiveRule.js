/**
 * Custom FESTIVE ABR Rule for dash.js v5
 * (unwrapped from IIFE, global var style)
 */

// Immediately Invoked Function

// Implementing FESTIVE Algorithm as outlined in this research paper here:
// https://dl.acm.org/doi/pdf/10.1145/2413176.2413189
// and was publicly implemented by the PENSIEVE github here:
// https://github.com/hongzimao/pensieve

// Grab the built‑in dash.js factories/constants from the global dash.js import that's called prior

var FestiveRule;  // ← global var, like LowestBitrateRuleTest

function FestiveRuleClass(config) {
    config = config || {};

    var FactoryMaker              = dashjs.FactoryMaker;
    var SwitchRequestFactory      = FactoryMaker.getClassFactoryByName('SwitchRequest');
    var Debug                     = FactoryMaker.getSingletonFactoryByName('Debug');
    var MetricsConstantsFactory   = FactoryMaker.getSingletonFactoryByName('MetricsConstants');
    var DashMetrics               = FactoryMaker.getSingletonFactoryByName('DashMetrics');

    var context       = this.context;
    var logger, dashMetrics;

    // Stability Window Size 
    var horizon = 5;

    // Efficiency Weight (12 as picked in Festive Paper)
    var alpha = 12;

    // Internal Variables for State 
    var prevQuality       = 0;
    var lastIndex         = 0;
    var switchUpCount     = 0;
    var qualityLog        = {};
    var bitrateArray      = null;
    var switchUpThreshold = [];

    function setup() {
        logger     = Debug(context).getInstance().getLogger(instance);
        dashMetrics = DashMetrics(context).getInstance();
    }

    function getClassName() {
        return 'FestiveRule';
    }

    // Choose highest quality possible
    function selectQuality(bitrate) {
        var quality = bitrateArray.length - 1;
        for (var i = bitrateArray.length - 1; i >= 0; i--) {
            if (bitrate >= bitrateArray[i]) {
                quality = i;
                break;
            }
        }
        return quality;
    }

    // Calculate stability score using our current quality (b_cur), and our target (b_ref)
    // b just is whether we are checking for b_ref or b_cur
    function getStabilityScore(b, b_ref, b_cur) {
        var changes = 0;
        var start   = Math.max(0, lastIndex - horizon);
        for (var i = start; i < lastIndex; i++) {
            if (qualityLog[i] !== qualityLog[i + 1]) {
                changes++;
            }
        }
        if (b !== b_cur) {
            changes++;
        }
        return Math.pow(2, changes);
    }

    // Calculate Efficiency Score 
    function getEfficiencyScore(b, b_ref, bwPrediction) {
        return Math.abs(bitrateArray[b] / Math.min(bwPrediction, bitrateArray[b_ref]) - 1);
    }

    // Get our combined score, which uses both Efficiency and Stability as well as the alpha weight  
    // Formula mentioned in FESTIVE paper
    function getCombinedScore(b, b_ref, b_cur, bwPrediction) {
        var stab = getStabilityScore(b, b_ref, b_cur);
        var eff  = getEfficiencyScore(b, b_ref, bwPrediction);
        return stab + alpha * eff;
    }

    // SwitchRequestFunction required by Dash.js 
    function getSwitchRequest(rulesContext) {
        try {
            var switchRequest = SwitchRequestFactory(context).create();
            switchRequest.rule = getClassName();

            // pull in all the controllers and state
            var mediaType            = rulesContext.getMediaType();
            var abrController        = rulesContext.getAbrController();
            var throughputController = rulesContext.getThroughputController();
            var scheduleController   = rulesContext.getScheduleController();
            var streamInfo           = rulesContext.getStreamInfo() || {};
            var streamId             = streamInfo.id;
            var isDynamic            = streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
            var currentBufferState   = dashMetrics.getCurrentBufferState(mediaType);
            var bufferLevel          = dashMetrics.getCurrentBufferLevel(mediaType);
            var throughput           = throughputController.getSafeAverageThroughput(mediaType);
            var latency              = throughputController.getAverageLatency(mediaType);

            // Safeguards as seen in RBRule.js 
            // Exit if no throughput or buffer info  
            console.log(throughput) 
            console.log(currentBufferState)
            if (isNaN(throughput) || !currentBufferState) {  
                console.log("EARLY RETURN");
                return switchRequest;
            }

            /*
            Note: 
            abrController.getAbandonmentStateFor(streamId, mediaType) checks whether the player has recently aborted a fragment download because it was too slow.

            Dash.js uses abandonment logic to:

            Detect when a high-quality fragment is taking too long

            Cancel it before it finishes

            Switch to a lower quality instead
            */
            if (abrController.getAbandonmentStateFor(streamId, mediaType) !==
                'allowload') { 
                console.log("ABANDON");
                logger.debug('[FestiveRule] Abandonment active - skipping ABR decision');
                return switchRequest;
            }

            // buffer‐loaded check (unless live)
            if (currentBufferState !== 'bufferLoaded') { 
                console.log("BUFFER");
                logger.debug('[FestiveRule] Buffer not loaded and not live - skipping ABR decision');
                return switchRequest;
            }

            // Initialize bitrate array and thresholds once
            if (!bitrateArray) {
                var reps = abrController.getPossibleVoRepresentations(rulesContext.getMediaInfo(), true);
                bitrateArray = reps.map(r => r/1000);
                switchUpThreshold = bitrateArray.map(function(_, i) {
                    return Math.min(i, horizon);
                });
            }

            // Log previous quality
            qualityLog[lastIndex] = prevQuality;
            lastIndex++;

            // Get bandwidth prediction from dash.js (byte-weighted harmonic mean over 20 segments * 0.85)
            // This was updated in the throughput calculation settings into dash.js player settings 
            var bwPrediction = throughputController.getSafeAverageThroughput(mediaType);
            if (isNaN(bwPrediction) || bwPrediction <= 0) { 
                console.log("NO BANDWIDTH");
                return switchRequest;
            }

            // Compute target quality index
            var b_target = selectQuality(bwPrediction);
            var b_cur    = prevQuality;
            var b_ref    = b_cur;

            // Throttle up-switches: need switchUpThreshold[b_cur] consecutive ups
            if (b_target > b_cur) {
                switchUpCount++;
                if (switchUpCount > switchUpThreshold[b_cur]) {
                    b_ref = b_cur + 1;
                }
            } else if (b_target < b_cur) {
                b_ref = b_cur - 1;
                switchUpCount = 0;
            } else {
                switchUpCount = 0;
            }

            // Make sure b_ref doesn't go out of bounds 
            b_ref = Math.max(0, Math.min(b_ref, bitrateArray.length - 1));

            // Decide: stay vs switch based on combined score
            var finalQuality = b_cur;
            if (b_ref !== b_cur) {
                var score_cur = getCombinedScore(b_cur, b_ref, b_cur, bwPrediction);
                var score_ref = getCombinedScore(b_ref, b_ref, b_cur, bwPrediction);
                finalQuality = score_cur <= score_ref ? b_cur : b_ref; 
                console.log(finalQuality); 
                if (finalQuality > b_cur) {
                    switchUpCount = 0;
                }
            }

            // Update state
            prevQuality = finalQuality;

            // Populate switch request
            var reps = abrController.getPossibleVoRepresentations(rulesContext.getMediaInfo(), true);
            switchRequest.representation = reps[finalQuality];
            switchRequest.priority       = SwitchRequestFactory.PRIORITY.STRONG;
            switchRequest.reason         = {
                throughput,
                latency,
                message: `[FestiveRule]: Switching to Representation with bitrate ${reps[finalQuality].bitrateInKbit} kbit/s. Throughput: ${throughput}`
            };

            // Schedule Controller
            scheduleController.setTimeToLoadDelay(2);
            return switchRequest;
        }
        catch (e) {
            logger.error(e);
            return SwitchRequestFactory(context).create();
        }
    }

    function reset() {
        prevQuality       = 0;
        lastIndex         = 0;
        switchUpCount     = 0;
        qualityLog        = {};
        bitrateArray      = null;
        switchUpThreshold = [];
    }

    var instance = {
        getClassName:     getClassName,
        getSwitchRequest: getSwitchRequest,
        reset:            reset
    };

    setup();
    return instance;
}

// register under the global dashjs FactoryMaker
FestiveRuleClass.__dashjs_factory_name = 'FestiveRule';
FestiveRule = dashjs.FactoryMaker.getClassFactory(FestiveRuleClass);
