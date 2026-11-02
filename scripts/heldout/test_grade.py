"""Pre-execution positive/negative checks of the fixed external grader."""
import csv
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile
from grade import archive_data, climate_expected, electricity_expected, link_spans, markdown_data

BASE = pathlib.Path(sys.argv[1]).resolve()
sys.argv = [sys.argv[0]]
def h(data): return hashlib.sha256(data).hexdigest()
def write_csv(path, items):
    with path.open("w", newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(items[0]));writer.writeheader();writer.writerows(items)
def archive_zip(out,name):
    with zipfile.ZipFile(out/name,"w") as z:
        for file in sorted(out.rglob("*")):
            if file.is_file() and file.name!=name:z.write(file,file.relative_to(out).as_posix())


class GraderTests(unittest.TestCase):
    def test_climate_oracle_distinguishes_growth_and_annual_means(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary)
            months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
            header=['Year',*months,'J-D']
            data=[dict(zip(header,[year,*([(year-2015)/10]*12),(year-2015)/10])) for year in range(2015,2026)]
            data.append(dict(zip(header,[2026,1.2,*(['***']*11),'***'])))
            with (root/'nasa-global.csv').open('w',newline='') as f:
                f.write('Land-Ocean: Global Means\n');w=csv.DictWriter(f,fieldnames=header);w.writeheader();w.writerows(data)
            (root/'noaa-co2-annual.txt').write_text('# year mean\n'+'\n'.join(f'{year} {200+2*(year-2014)} .1' for year in range(2014,2026)))
            (root/'noaa-co2-growth.txt').write_text('# year growth\n'+'\n'.join(f'{year} 1.5 .1' for year in range(2015,2026)))
            annual,summary=climate_expected(root)
            self.assertEqual(annual[0]['co2_mean_delta_ppm'],2)
            self.assertEqual(annual[0]['noaa_growth_ppm'],1.5)
            self.assertAlmostEqual(summary['temp_mean_2015_2025'],.5)
            self.assertAlmostEqual(summary['temp_slope_c_per_decade'],1)
            self.assertEqual(summary['co2_change_2015_2025'],20)
            self.assertEqual(summary['excluded_partial_years'],[2026])

    def test_electricity_oracle_weights_and_unit_conversion(self):
        from grade import REGIONS
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary)
            variables=[('electricity-generation.csv','Total electricity',lambda i,y:i),('carbon-intensity-electricity.csv','Carbon intensity',lambda i,y:i*10),('share-electricity-renewables.csv','Renewables',lambda i,y:10+i+(y-2015)*.5),('share-electricity-fossil-fuels.csv','Fossil fuels',lambda i,y:70-i)]
            for filename,column,value in variables:
                write_csv(root/filename,[{'Entity':entity,'Code':'X','Year':year,column:value(i,year)} for i,entity in enumerate(REGIONS,1) for year in range(2014,2026)])
            panel,sample,summary=electricity_expected(root)
            self.assertEqual(len(panel),99)
            self.assertEqual(sample[-1]['generation_twh'],36)
            self.assertAlmostEqual(sample[-1]['weighted_intensity_gco2e_kwh'],2040/36)
            self.assertEqual(sample[-1]['simple_mean_intensity_gco2e_kwh'],45)
            self.assertAlmostEqual(sample[-1]['implied_lifecycle_mtco2e'],2.04)
            self.assertEqual(summary['largest_renewable_gain_entity'],'Brazil')

    def test_archive_accepts_gold_and_rejects_corrupt_entity(self):
        with tempfile.TemporaryDirectory() as temporary:
            work=pathlib.Path(temporary);inputs=work/'inbox';out=work/'deliverables'
            (inputs/'nested').mkdir(parents=True);(out/'files').mkdir(parents=True)
            originals={'a.txt':b'same','b.txt':b'same','nested/a.txt':b'other','empty':b''}
            canonical={'a.txt':'a.txt','b.txt':'a.txt','nested/a.txt':'nested/a.txt','empty':'empty'}
            manifest=[]
            for name,data in sorted(originals.items()):
                (inputs/name).write_bytes(data);first=canonical[name];target='files/'+h(data)+pathlib.Path(first).suffix
                (out/target).write_bytes(data)
                manifest.append({'source':name,'target':target,'sha256':h(data),'bytes':len(data),'canonical_source':first,'is_duplicate':str(name!=first).lower()})
            write_csv(out/'manifest.csv',manifest)
            (out/'audit.json').write_text(json.dumps({'source_files':4,'unique_files':3,'duplicate_files':1,'source_bytes':13,'unique_bytes':9,'skipped_symlinks':[]}))
            (out/'INDEX.md').write_text('manifest.csv archive.zip')
            archive_zip(out,'archive.zip');archive_data(work)
            (out/manifest[0]['target']).write_bytes(b'bad')
            with self.assertRaises(AssertionError):archive_data(work)

    def test_markdown_accepts_gold_and_rejects_code_block_rewriting(self):
        with tempfile.TemporaryDirectory() as temporary:
            work=pathlib.Path(temporary);vault=work/'vault';out=work/'deliverables'
            (vault/'nested').mkdir(parents=True);(out/'pages').mkdir(parents=True);(out/'assets').mkdir()
            original='# A\n[ref](nested/b.md#part)\n![logo](logo.svg)\n```md\n[x](nested/b.md)\n```\n`[x](nested/b.md)`\n[ext](https://example.org)\n[anchor](#a)\n[book]: nested/b.md "Title"\n<img src="logo.svg">\n'
            asset=b'<svg/>';target='assets/'+h(asset)+'.svg'
            moved=original.replace('[ref](nested/b.md#part)','[ref](0002.md#part)').replace('![logo](logo.svg)','![logo](../'+target+')').replace('[book]: nested/b.md','[book]: 0002.md').replace('src="logo.svg"','src="../'+target+'"')
            (vault/'alpha.md').write_text(original);(vault/'nested/b.md').write_text('# B\n');(vault/'logo.svg').write_bytes(asset)
            (out/'pages/0001.md').write_text(moved);(out/'pages/0002.md').write_text('# B\n');(out/target).write_bytes(asset)
            originals=[('alpha.md','pages/0001.md','markdown'),('logo.svg',target,'asset'),('nested/b.md','pages/0002.md','markdown')]
            write_csv(out/'mapping.csv',[{'source':source,'target':dest,'source_sha256':h((vault/source).read_bytes()),'target_sha256':h((out/dest).read_bytes()),'kind':kind} for source,dest,kind in originals])
            links=[('nested/b.md#part','0002.md#part','rewritten'),('logo.svg','../'+target,'rewritten'),('https://example.org','https://example.org','unchanged'),('#a','#a','unchanged'),('nested/b.md','0002.md','rewritten'),('logo.svg','../'+target,'rewritten')]
            write_csv(out/'links.csv',[{'source':'alpha.md','original':source,'target':dest,'status':status} for source,dest,status in links])
            (out/'audit.json').write_text(json.dumps({'source_files':3,'markdown_files':2,'asset_files':1,'unique_assets':1,'rewritten_links':4,'unchanged_links':2,'unresolved_links':0}))
            (out/'INDEX.md').write_text('alpha.md pages/0001.md nested/b.md pages/0002.md')
            archive_zip(out,'library.zip');markdown_data(work)
            self.assertEqual(len(link_spans(original)),6)
            (out/'pages/0001.md').write_text(moved.replace('[x](nested/b.md)','[x](0002.md)'))
            with self.assertRaises(AssertionError):markdown_data(work)

    def test_upstream_code_loads_and_new_features_are_detectably_missing(self):
        for task in ['code-cache','code-cli']:
            with tempfile.TemporaryDirectory() as temporary:
                file=pathlib.Path(temporary)/'checks.json'
                result=subprocess.run(['node',str(pathlib.Path(__file__).with_name('code-grade.mjs')),task,str(BASE/'fixtures'/task),str(file)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                self.assertEqual(result.returncode,0,result.stderr.decode())
                checks=json.loads(file.read_text())['checks']
                self.assertTrue(all(c['passed'] for c in checks if c['id'].startswith('existing-')))
                self.assertTrue(any(not c['passed'] for c in checks))


if __name__=='__main__':unittest.main()
