import { useLiveData } from "./lib/useLiveData.js";
import TopBar from "./components/TopBar.jsx";
import Sidebar from "./components/Sidebar.jsx";
import RoomOverview from "./components/RoomOverview.jsx";
import BentoStatus from "./components/BentoStatus.jsx";
import HistorySection from "./components/HistorySection.jsx";
import Ticker from "./components/Ticker.jsx";

export default function App() {
  const live = useLiveData();
  const {
    rooms,
    currentRoom,
    latest,
    colorScale,
    connected,
    rangeMin,
    setRangeMin,
    selectedRoom,
    setSelectedRoom,
    selectedSensor,
    setSelectedSensor,
    isStale,
    history,
  } = live;

  const selectRoom = (id) => {
    setSelectedRoom(id);
    setSelectedSensor(null);
  };
  const selectSensor = (id) => setSelectedSensor(id);

  return (
    <main className="bg-mesh min-h-screen w-full max-w-full overflow-x-hidden">
      <TopBar connected={connected} />
      <div className="pt-24">
        <Ticker rooms={rooms} latest={latest} />
        <div className="mx-auto flex max-w-shell px-0">
          <div className="hidden w-[262px] shrink-0 lg:block">
            <div className="sticky top-24 h-[calc(100vh-7rem)] overflow-y-auto">
              <Sidebar
                rooms={rooms}
                selectedRoom={selectedRoom}
                selectedSensor={selectedSensor}
                latest={latest}
                isStale={isStale}
                onSelectRoom={selectRoom}
                onSelectSensor={selectSensor}
              />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            {currentRoom ? (
              <>
                <RoomOverview
                  room={currentRoom}
                  latest={latest}
                  colorScale={colorScale}
                  selectedSensor={selectedSensor}
                  onSelectSensor={selectSensor}
                />
                <BentoStatus
                  rooms={rooms}
                  latest={latest}
                  selectedRoom={selectedRoom}
                  onSelectRoom={selectRoom}
                />
                <HistorySection
                  room={currentRoom}
                  history={history}
                  latest={latest}
                  colorScale={colorScale}
                  rangeMin={rangeMin}
                  setRangeMin={setRangeMin}
                  selectedSensor={selectedSensor}
                  onSelectSensor={selectSensor}
                />
              </>
            ) : (
              <div className="flex h-[70vh] items-center justify-center text-mut">
                Loading cold rooms…
              </div>
            )}
          </div>
        </div>
        <footer className="border-t border-line px-6 py-8 text-center text-[12px] text-mut">
          Veze Sharri · Lecker — PT100 cold-chain telemetry ·{" "}
          {connected ? "streaming live" : "reconnecting…"}
        </footer>
      </div>
    </main>
  );
}
