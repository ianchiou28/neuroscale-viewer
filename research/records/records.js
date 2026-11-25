const filters = document.querySelector("#filters");
const input = document.querySelector("#search");
const topic = document.querySelector("#topic");
const count = document.querySelector("#record-count");
const records = Array.from(document.querySelectorAll(".record"));
const groups = Array.from(document.querySelectorAll(".archive-group"));
const searchable = records.map(record => record.textContent.toLocaleLowerCase());

function filterRecords() {
  const terms = input.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  let total = 0;
  records.forEach((record, index) => {
    const matchesTopic = topic.value === "" || record.dataset.topic === topic.value;
    record.hidden = !matchesTopic || !terms.every(term => searchable[index].includes(term));
    if (!record.hidden) total += 1;
  });
  for (const group of groups) {
    group.hidden = !group.querySelector(".record:not([hidden])");
  }
  count.textContent = total === 0 ? "没有符合条件的记录" : `${total} 篇记录`;
}

function openLinkedRecord() {
  const id = window.location.hash.slice(1);
  if (!/^r\d{2}$/.test(id)) return;
  const target = document.getElementById(id);
  if (!target) return;
  if (target.hidden) {
    input.value = "";
    topic.value = "";
    filterRecords();
  }
  target.open = true;
  target.scrollIntoView({ block: "start" });
}

filters.hidden = false;
input.addEventListener("input", filterRecords);
topic.addEventListener("change", filterRecords);
window.addEventListener("hashchange", openLinkedRecord);
document.querySelector("#records").addEventListener("click", event => {
  const anchor = event.target.closest("a");
  if (anchor?.hash && anchor.hash === window.location.hash && anchor.pathname === window.location.pathname) {
    openLinkedRecord();
  }
});
filterRecords();
openLinkedRecord();
