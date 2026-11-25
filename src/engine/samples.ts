export interface SampleDoc {
  id: string;
  label: string;
  blurb: string;
  text: string;
}

export const SAMPLES: SampleDoc[] = [
  {
    id: "discharge",
    label: "Hospital discharge summary",
    blurb: "Short, private: identifiers, diagnosis and medication.",
    text: `Riverside Community Hospital — Discharge Summary

Patient: Daniel R. Okafor, DOB 1988-03-14, MRN 4471-2291
Contact: +1 415 555 0134, d.okafor@mailbox.example
Admitted: 2026-11-02 08:40  Discharged: 2026-11-05 14:10
Attending: Dr. Mei-Ling Tran, Internal Medicine

Reason for admission
Chest pain on exertion, with shortness of breath lasting four days. The patient reported no syncope, no palpitations at rest, and no fever.

Diagnosis and findings
1. Stable angina, confirmed by a positive stress test on 2026-11-03.
2. Mild hypertension, average office reading 146/92.
3. Vitamin D deficiency, incidental on blood test.

Procedure
Diagnostic catheterisation on 2026-11-04. A single 60% lesion was found in the mid LAD and was treated medically rather than with stenting. No dissection, no perforation, no access-site complication.

Medication prescribed
Atorvastatin 40 mg once nightly.
Metoprolol succinate 25 mg once daily, titrate to resting heart rate under 65.
Aspirin 81 mg once daily.
Nitroglycerin 0.4 mg sublingual as needed, maximum three doses.

Follow-up
Cardiology clinic on 2026-11-24 at 10:30 with Dr. Tran. Repeat lipid panel and liver enzymes before that visit. Return immediately for chest pain at rest, new breathlessness, or fainting.

Instructions given
Keep a symptom diary for two weeks. Avoid heavy lifting over 5 kg for one week, then resume gradually. The patient was told not to drive for 48 hours after sedation.

Signed: Dr. Mei-Ling Tran, 2026-11-05.`,
  },
  {
    id: "nda",
    label: "Vendor NDA excerpt",
    blurb: "Long and private: device-only map-reduce, or a masked copy.",
    text: `MUTUAL NON-DISCLOSURE AGREEMENT
Between Northwind Logistics Ltd. and Kestrel Data Systems Inc.
Effective date: 2026-11-01. Reference: NDA-2026-4471.

1. Purpose
The parties intend to explore a joint pilot for predictive maintenance on refrigerated freight. Each party may share confidential information with the other solely for that purpose.

2. Confidential information
"Confidential Information" means any non-public information disclosed by one party to the other, in any form, that is marked confidential or that a reasonable recipient would understand to be confidential given its nature and the circumstances of disclosure. It includes pricing, route plans, customer lists, sensor telemetry, source code, and the terms of this agreement.

3. Obligations of the receiving party
The receiving party must keep the Confidential Information confidential, use it only for the Purpose, and disclose it only to its employees and advisers who need it for the Purpose and who are bound by obligations at least as protective as this agreement. The receiving party must protect it with at least the same care it uses for its own confidential information, and never less than reasonable care.

4. Exclusions
Confidential Information does not include information that is or becomes public without breach of this agreement, was already known to the receiving party without a duty of confidence, is received from a third party without a duty of confidence, or is independently developed without use of the Confidential Information.

5. Compelled disclosure
If the receiving party is required by law or court order to disclose Confidential Information, it must, to the extent legally permitted, give the disclosing party prompt notice so that the disclosing party may seek protective measures, and it must disclose only the portion legally required.

6. Term
This agreement begins on the effective date and continues for two years. The confidentiality obligations survive for three years after termination. Neither party is obliged to disclose any information and either party may terminate the pilot discussions on 30 days written notice.

7. No warranty, no licence
All Confidential Information is provided as is, with no warranty of accuracy or completeness. Nothing in this agreement grants a licence to any intellectual property, except the limited right to use the information for the Purpose.

8. Remedy
The parties agree that a breach of this agreement may cause harm that money cannot repair, and that the disclosing party may seek injunctive relief in addition to other remedies. The parties agree that liquidated damages of USD 50,000 per breach would be a reasonable pre-estimate of loss for unauthorised disclosure of route plans or pricing.

9. Governing law
This agreement is governed by the laws of the State of Delaware. Disputes go to arbitration in Wilmington under the rules of the American Arbitration Association. Each party bears its own costs unless the arbitrator decides otherwise.

Signed for Northwind Logistics Ltd.
Priya Nandakumar, Head of Operations — p.nandakumar@northwind.example — +1 302 555 0119

Signed for Kestrel Data Systems Inc.
Tomas Bergstrom, Chief Technology Officer — t.bergstrom@kestreldata.example

Annex A: contact list and site access rules. Two warehouses are in scope in the first phase: Newark Yard 3 and Rotterdam Cold Store 2. Site access requires a safety induction valid for twelve months. All sensor telemetry must be time-stamped to within 500 ms and retained for 90 days. Kestrel will provide one integration engineer for the pilot; Northwind covers travel costs up to USD 4,000.`,
  },
  {
    id: "brief",
    label: "Public policy newsletter",
    blurb: "Long and public: cloud synthesis, after its footer address is masked.",
    text: `The Grid Letter — Issue 412

Why the next two years of data-centre growth will be decided by substations, not chips

For most of the past decade the question about artificial intelligence was which model, then which chip. Both questions now have workable answers for the largest buyers. The bottleneck has moved to an unglamorous piece of civil infrastructure: the substation that connects a site to the transmission network, and the queue that controls when it can be built.

The numbers explain the shift. A single large training campus built in 2022 drew 20 to 40 megawatts. Campuses announced this year are designed for 300 megawatts and more, with options to grow. A 300 megawatt load is the size of a mid-sized city. It cannot be added to a distribution network without new transformers, new switchgear and, in most jurisdictions, a new transmission line.

Three constraints decide how quickly that can happen.

First, transformers. Large power transformers are built to order. Lead times, which were 12 to 18 months before 2020, have stretched to 40 months or more for the highest voltage classes, and a handful of factories make the components inside them. Buyers who did not reserve capacity in 2024 are already looking at 2028 energisation dates.

Second, interconnection queues. In the United States, more than 2,600 gigawatts of generation and storage sit in queues waiting for studies. Data-centre loads now enter a parallel process for large-load interconnection, and in several regions those requests have grown faster than the engineering teams that process them. A queue position is not a promise; it is a place in a line that can take four years to reach the front.

Third, the local politics of siting. A campus needs land, water for cooling, and a community willing to accept the traffic, the noise of cooling equipment and the visual impact of a substation. Municipal approval has become the least predictable step in the chain, and in some regions a single council vote has delayed a project by two years.

What operators are doing about it

The most striking change is that the largest buyers have started to behave like utilities. They are buying existing generation, contracting for dedicated nuclear capacity, funding transmission upgrades themselves, and in a few cases building gas turbines on site. Each of these is a bet that speed matters more than the cheapest possible electron.

A second change is the return of the behind-the-meter approach. Instead of waiting in a queue, a site can connect a smaller load quickly and grow in stages as the network catches up. Staged builds cost more per megawatt and complicate cooling and networking design, but they start producing revenue years earlier.

A third is geographic dispersion. Rather than one 500 megawatt campus, operators are spreading training and inference across four sites of 120 megawatts each in different grid regions. Training a model across sites is harder and slower, but inference, which is most of the eventual load, distributes naturally.

What to watch in the next four quarters

The transformer order book. If lead times fall below 30 months, the constraint is easing. If they keep growing, expect more acquisitions of older plants that already hold equipment.

Large-load tariffs. Regulators are writing rules that make very large customers pay for the network upgrades they trigger. Watch the first few approved tariffs; they will set the template everywhere.

Water disclosure. Cooling design is shifting to closed loop systems, but disclosure is still voluntary. Mandatory reporting would change siting decisions quickly.

The longer view

Grid capacity was built for a world where demand grew about one percent a year. Computing demand now grows in steps, and each step is large enough to require physical construction that cannot be compressed by software. The companies that win the next phase of artificial intelligence will be the ones that learned to run a construction programme as well as a research lab.

Corrections and letters: letters@thegridletter.example. The Grid Letter is published every Tuesday and is free to read.`,
  },
  {
    id: "korean-record",
    label: "국문 진단서 (Korean medical record)",
    blurb: "Korean identifiers: 주민등록번호와 진단 내용이 그대로 담긴 문서.",
    text: `진 단 서

환자 성명: 김민수
주민등록번호: 900315-1234567
연락처: 010-2841-7734
주소: 서울특별시 마포구 월드컵북로 41

진단명: 급성 위염 및 역류성 식도염
발병일: 2026년 11월 8일
진단일: 2026년 11월 10일

임상 소견
환자는 3일 전부터 상복부 통증과 속쓰림을 호소하여 내원하였다. 내시경 검사 결과 위 점막의 미란과 하부 식도 괄약근의 이완이 관찰되었다. 출혈 소견은 없으며 조직 검사상 악성 병변은 확인되지 않았다.

처방 내역
판토프라졸 40mg 1일 1회 4주
모사프리드 5mg 1일 3회 2주
복용 기간 중 음주와 카페인 섭취를 금하도록 교육함.

향후 계획
2주 후 외래 재진하여 증상 호전 여부를 확인하고, 호전이 없을 경우 추가 검사를 시행할 예정이다.

발급일: 2026년 11월 11일
발급 의료기관: 서울 연세내과의원
담당 의사: 이지훈 (면허번호 제 41207 호)`,
  },
];
