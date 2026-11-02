"""Aggregate all attempts after frozen mechanical checks and documented semantic review."""
import json
import pathlib
import statistics
import sys

base=pathlib.Path(sys.argv[1]).resolve()
results=json.loads((base/'results.json').read_text())
review=json.loads((base/'semantic-review.json').read_text())
by_sequence={str(item['sequence']):item for item in review['runs']}
records=[]
for result in results:
    directory=pathlib.Path(result['directory']);grade=json.loads((directory/'grade.json').read_text())
    semantic=by_sequence[str(result['sequence'])]
    artifacts=grade['machineAllCriticalPassed'] and semantic['allCriticalPassed']
    delivered=artifacts and result.get('hostDeclaredComplete',False)
    claims=result.get('hostDeclaredComplete',False) if result['arm']=='extension' else semantic['claimsComplete']
    records.append({**result,'machineAllCriticalPassed':grade['machineAllCriticalPassed'],'semanticAllCriticalPassed':semantic['allCriticalPassed'],
                    'artifactAllCriticalPassed':artifacts,'autonomousQualifiedDelivery':delivered,'incorrectCompletionClaim':claims and not artifacts,
                    'goodArtifactsNotDelivered':artifacts and not result.get('hostDeclaredComplete',False),
                    'semanticEvidence':semantic['evidence'],'failedChecks':[item['id'] for item in grade['checks'] if not item['passed']]})
arms={}
for arm in ['pi','prompt','extension']:
    selected=[item for item in records if item['arm']==arm]
    cost=[item['budget']['estimatedCostUsd'] for item in selected if item.get('budget')]
    arms[arm]={'attempts':len(selected),'qualifiedDeliveries':sum(item['autonomousQualifiedDelivery'] for item in selected),
               'artifactPasses':sum(item['artifactAllCriticalPassed'] for item in selected),'incorrectCompletionClaims':sum(item['incorrectCompletionClaim'] for item in selected),
               'goodArtifactsNotDelivered':sum(item['goodArtifactsNotDelivered'] for item in selected),
               'externalFollowupMessages':sum(item.get('operatorFollowupMessages',0) for item in selected),
               'runsRequestingUserInput':sum(bool(item.get('userInformationRequests')) or by_sequence[str(item['sequence'])].get('requestsUserInput',False) for item in selected),
               'automaticContinuations':sum(item.get('automaticContinuations',0) for item in selected),
               'estimatedCostUsd':sum(cost),'medianTaskCostUsd':statistics.median(cost) if cost else None,
               'elapsedMs':sum(item['elapsedMs'] for item in selected),'maxTaskElapsedMs':max((item['elapsedMs'] for item in selected),default=0),
               'compactions':sum(item.get('compactions',0) for item in selected),'workerCount':sum(item.get('workerCount',0) for item in selected),
               'budgetLimited':sum(item['execution']=='budget_limited' for item in selected),
               'interruptedRuns':sum(item.get('interruption',{}).get('injected',False) for item in selected),
               'transientErrors':sum(item.get('fault',{}).get('injected',False) for item in selected)}
paired=[];repeated_unique=[];tasks=sorted({item['task'] for item in records})
for task in tasks:
    wins=[]
    for repeat in [1,2]:
        cell={item['arm']:item for item in records if item['task']==task and item['repeat']==repeat}
        if len(cell)!=3:continue
        p,e=cell['pi'],cell['extension']
        if p['autonomousQualifiedDelivery'] and e['autonomousQualifiedDelivery'] and p['budget']['estimatedCostUsd']>0:
            paired.append({'task':task,'repeat':repeat,'costRatio':e['budget']['estimatedCostUsd']/p['budget']['estimatedCostUsd']})
        wins.append(e['autonomousQualifiedDelivery'] and not p['autonomousQualifiedDelivery'] and not cell['prompt']['autonomousQualifiedDelivery'])
    if len(wins)==2 and all(wins):repeated_unique.append(task)
cost_ratio=statistics.median(pair['costRatio'] for pair in paired) if paired else None
summary={'arms':arms,'allAttempts':len(records),'estimatedTotalCostUsd':sum(value['estimatedCostUsd'] for value in arms.values()),
         'pairedSuccessfulRuns':paired,'medianCandidateCostRatioVsPi':cost_ratio,'repeatedUniqueDeliveryWins':repeated_unique,
         'screen':{'atLeastTwoRepeatedUniqueWins':len(repeated_unique)>=2,
                   'noMoreIncorrectCompletionsThanPi':arms['extension']['incorrectCompletionClaims']<=arms['pi']['incorrectCompletionClaims'],
                   'medianAdditionalCostWithin25Percent':cost_ratio is not None and cost_ratio<=1.25},
         'limits':['Six tasks and two repetitions are an engineering screen, not statistical proof.',
                   'No external follow-up was permitted. Failed zero-message runs are not qualified autonomous deliveries.',
                   'All arms share the same tools, methods and approved brief; individual-module causal benefit is not isolated.',
                   'Semantic review is by the current coding assistant with condition labels masked where practical; not independent human double-blind review.',
                   'Pi ledger includes main/workers/compaction, but not this Codex authoring/review usage or local CPU. Interrupted requests may lack complete usage.']}
(base/'qualified-records.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
(base/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
