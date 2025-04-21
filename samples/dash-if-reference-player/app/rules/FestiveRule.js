(function(){
    'use strict';  

    // Immediately Invoked Function 

    // Implementing FESTIVE Algorithm as outlined in this research paper here: https://dl.acm.org/doi/pdf/10.1145/2413176.2413189 and was
    // publicly implemented by the PENSIEVE github here: https://github.com/hongzimao/pensieve  

    // Grab the built‑in dash.js factories/constants from the global dash.js import that's called prior

    const FactoryMaker = dashjs.FactoryMaker;
    const SwitchRequestFactory = FactoryMaker.getClassFactoryByName('SwitchRequest');
    const Debug = FactoryMaker.getSingletonFactoryByName('Debug');
    const MetricsConstants = FactoryMaker.getSingletonFactoryByName('MetricsConstants'); 

    function FestiveRuleClass(config){
        config = config || {};
        const context       = this.context;
        const dashMetrics   = config.dashMetrics;
        let instance, logger; 
        
        // Stability Window Size 
        const horizon = 5 

        // Efficiency Weight (12 as picked in Festive Paper)
        const alpha = 12 

        // Internal Variables for State 
        let prevQuality = 0; 
        let lastIndex = 0;
        let switchUpCount = 0;
        let qualityLog = {};
        let bitrateArray = null;
        let switchUpThreshold = []; 

        function setup() {
            logger = Debug(context).getInstance().getLogger(instance);
        } 

        function getClassName(){
            return 'FestiveRule'
        }  
        
        // Choose highest quality possible
        function selectQuality(bitrate){
            let quality = bitrateArray.length - 1;
            for (let i = bitrateArray.length - 1; i >= 0; i--) {
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
            let changes = 0;
            const start = Math.max(0, lastIndex - horizon);
            for (let i = start; i < lastIndex; i++) {
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
            const stab = getStabilityScore(b, b_ref, b_cur);
            const eff  = getEfficiencyScore(b, b_ref, bwPrediction);
            return stab + alpha * eff;
        } 
        // SwitchRequestFunction required by Dash.js 
        function getSwitchRequest(rulesContext) {
            try{
                const switchRequest = SwitchRequestFactory(context).create(); 
                switchRequest.rule = getClassName() 

                // pull in all the controllers and state
                const mediaType           = rulesContext.getMediaType();
                const abrController       = rulesContext.getAbrController();
                const throughputController= rulesContext.getThroughputController();
                const scheduleController  = rulesContext.getScheduleController();
                const streamInfo          = rulesContext.getStreamInfo() || {};
                const streamId            = streamInfo.id;
                const isDynamic           = streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
                const currentBufferState  = dashMetrics.getCurrentBufferState(mediaType);
                const bufferLevel         = dashMetrics.getCurrentBufferLevel(mediaType);
                const throughput          = throughputController.getSafeAverageThroughput(mediaType);
                const latency             = throughputController.getAverageLatency(mediaType);

                // Safeguards as seen in RBRule.js 
                // Exit if no throughput or buffer info
                if (isNaN(throughput) || !currentBufferState) {
                    return switchRequest;
                } 
                /* 
                Note: 
                abrController.getAbandonmentStateFor(streamId, mediaType) checks whether the player has recently aborted a fragment download because it was too slow.

                Dash.js uses abandonment logic to:

                Detect when a high-quality fragment is taking too long

                Cancel it before it finishes

                Switch to a lower quality instead  */
                if (abrController.getAbandonmentStateFor(streamId, mediaType) !== MetricsConstants.ALLOW_LOAD) {
                    logger.debug('[FestiveRule] Abandonment active - skipping ABR decision');
                    return switchRequest;
                }
                // buffer‐loaded check (unless live)
                if (currentBufferState.state !== MetricsConstants.BUFFER_LOADED && !isDynamic) {
                    logger.debug('[FestiveRule] Buffer not loaded and not live - skipping ABR decision');
                    return switchRequest;
                }

                // Initialize bitrate array and thresholds once
                if (!bitrateArray) {
                    const reps = abrController.getPossibleVoRepresentationsFilteredBySettings(
                        rulesContext.getMediaInfo(),
                        true
                    );
                    bitrateArray = reps.map(r => r.bandwidth / 1000);
                    switchUpThreshold = bitrateArray.map((_, i) => Math.min(i, horizon));
                }

                // Log previous quality
                qualityLog[lastIndex] = prevQuality;
                lastIndex++;

                // Get bandwidth prediction from dash.js (byte-weighted harmonic mean over 20 segments * 0.85)
                // This was updated in the throughput calculation settings into dash.js player settings 
                const bwPrediction = throughputController.getSafeAverageThroughput(mediaType);
                if (isNaN(bwPrediction) || bwPrediction <= 0) {
                    return switchRequest;
                }

                // Compute target quality index
                const b_target = selectQuality(bwPrediction);
                const b_cur    = prevQuality;
                let b_ref      = b_cur;

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
                //Make sure b_ref doesn't go out of bounds 
                b_ref = Math.max(0, Math.min(b_ref, bitrateArray.length - 1));

                // Decide: stay vs switch based on combined score
                let finalQuality = b_cur;
                if (b_ref !== b_cur) {
                    const score_cur = getCombinedScore(b_cur, b_ref, b_cur, bwPrediction);
                    const score_ref = getCombinedScore(b_ref, b_ref, b_cur, bwPrediction);
                    finalQuality = score_cur <= score_ref ? b_cur : b_ref;
                    if (finalQuality > b_cur) {
                        switchUpCount = 0;
                    }
                }

                // Update state
                prevQuality = finalQuality;

                // Populate switch request
                switchRequest.quality = finalQuality;

                switchRequest.reason = {
                    throughput,
                    latency,
                    message:`[FestiveRule]: Switching to Representation with bitrate ${switchRequest.representation ? switchRequest.representation.bitrateInKbit : 'n/a'} kbit/s. Throughput: ${throughput}`
                }; 

                // switchRequest.reason = {
                //     message: `[FestiveRule] Q${finalQuality}, BW=${Math.round(bwPrediction)} kbps`,
                //     b_target,
                //     b_ref,
                //     bandwidth: Math.round(bwPrediction)
                // };  

                // Schedule Controller
                scheduleController.setTimeToLoadDelay(0);
                return switchRequest;
            }
            catch(e){ 
                logger.error(e);
                return SwitchRequestFactory(context).create();
            }
        } 
        
        function reset() {
            prevQuality = 0;
            lastIndex = 0;
            switchUpCount = 0;
            qualityLog = {};  
            bitrateArray = null;
            switchUpThreshold = [];
        }

        instance = {
            getClassName,
            getSwitchRequest,
            reset
        };
        setup();
        return instance;
    }
    // register under the global dashjs FactoryMaker
    FestiveRuleClass.__dashjs_factory_name = 'FestiveRule';
    window.FestiveRule = FactoryMaker.getClassFactory(FestiveRuleClass);
})();