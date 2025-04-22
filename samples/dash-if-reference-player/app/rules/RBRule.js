(function() {
    'use strict'; 

    // Immediately Invoked Function Expression !  

    //Writing simple modified Rate Based algorithm for the sake of testing 
    //Will be very similar to Throughput with some minor tweaks 

    // Grab the built‑in dash.js factories/constants from the global dash.js import that's called prior
    var FactoryMaker      = dashjs.FactoryMaker;
    var SwitchRequestFactory = FactoryMaker.getClassFactoryByName('SwitchRequest');
    var MetricsConstants  = FactoryMaker.getSingletonFactoryByName('MetricsConstants');
    var Debug             = FactoryMaker.getSingletonFactoryByName('Debug');
    const DashMetrics = FactoryMaker.getSingletonFactoryByName('DashMetrics');

    function RBRuleClass(config) {
        config = config || {};
        const context       = this.context;
        let instance, logger, dashMetrics;

       
        // Internal Variables 
        // LastQuality will help us decide whether we increase the quality based off of what was given last 
        // consecutiveHigh will let us make sure that the bitrate is sustainable before switching  
        // (Has to be the same or around the same bitrate) consecutively
        let lastQuality     = NaN;
        let consecutiveHigh = 0;

        function setup() {
            logger = Debug(context).getInstance().getLogger(instance); 
            dashMetrics = DashMetrics(context).getInstance(); 
        }

        function getClassName() {
            return 'RBRule';
        }

        function getSwitchRequest(rulesContext) {
            try {
                const switchRequest       = SwitchRequestFactory(context).create();
                switchRequest.rule      = getClassName();

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
                if (abrController.getAbandonmentStateFor(streamId, mediaType) !== dashjs.ALLOW_LOAD) {
                    logger.debug('[RBRule] Abandonment active - skipping ABR decision');
                    return switchRequest;
                }
                // buffer‐loaded check (unless live)
                if (currentBufferState !== dashjs.BUFFER_LOADED && !isDynamic) {
                    logger.debug('[RBRule] Buffer not loaded and not live - skipping ABR decision');
                    return switchRequest;
                }

                // get available representations & their bitrates (kbps)
                const reps     = abrController.getPossibleVoRepresentationsFilteredBySettings(rulesContext.getMediaInfo(), true);
                const bitrates = reps.map(r => r.bandwidth / 1000); //kbps 
                const usable_TP   = throughput; // you could multiply by a safety margin here

                // pick the highest index that fits
                let candidate = 0  
                for (let i = bitrates.length - 1; i >= 0; i--){
                    if(usable_TP >= bitrates[i]){
                        candidate = i 
                        break; 
                    }
                }  

                //We only switch with consistent/sustainable bitrate
                if(!isNaN(lastQuality) && candidate > lastQuality){
                    if(consecutiveHigh >= 2 && bufferLevel > 5){
                        logger.debug(`[RBRule] Upshifting to ${candidate}`) 
                    }else{ 
                        //We want to keep the quality to what it was
                        candidate = lastQuality;  
                        logger.debug('[RBRule] Preventing upshift due to insufficient stability');
                    }
                }  

                //This tells us it's sustainable
                if (!isNaN(lastQuality) && usable_TP >= bitrates[lastQuality]){
                    consecutiveHigh++; 
                }else{ 
                    consecutiveHigh = 0
                } 
                lastQuality = candidate;

                // build the SwitchRequest
                switchRequest.representation = reps[candidate] 
                switchRequest.reason = {
                    throughput,
                    latency,
                    message:`[RBRule]: Switching to Representation with bitrate ${switchRequest.representation ? switchRequest.representation.bitrateInKbit : 'n/a'} kbit/s. Throughput: ${throughput}`
                };

                // Schedule Controller
                scheduleController.setTimeToLoadDelay(0);
                return switchRequest;
            } catch (e) {
                logger.error(e);
                return SwitchRequestFactory(context).create();
            }
        }

        function reset() {
            lastQuality     = NaN;
            consecutiveHigh = 0;
        }

        instance = {
            getSwitchRequest, 
            reset, 
            getClassName
        } 

        setup();
        return instance;
    }

    // register under the global dashjs FactoryMaker
    RBRuleClass.__dashjs_factory_name = 'RBRule';
    window.RBRule = dashjs.FactoryMaker.getClassFactory(RBRuleClass);
})();
